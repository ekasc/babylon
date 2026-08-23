import { useState } from "react";
import {
  newScheduledTaskId,
  registerScheduledTask,
  removeScheduledTask,
  setScheduledTaskEnabled,
  type ScheduledTask,
  type ScheduledTaskRegistry,
  type Trigger,
} from "../automation";
import type { AutomationHistory } from "../automation-runner";
import { useModalDialog } from "./useModalDialog";

function describeTrigger(trigger: Trigger): string {
  switch (trigger.kind) {
    case "interval": {
      const ms = trigger.intervalMs ?? 0;
      if (ms <= 0) return "invalid interval";
      if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
      if (ms % 60_000 === 0) return `every ${ms / 60_000}m`;
      return `every ${Math.floor(ms / 1000)}s`;
    }
    case "daily":
      return `daily at ${String(trigger.hour ?? 0).padStart(2, "0")}:${String(trigger.minute ?? 0).padStart(2, "0")} UTC`;
    case "file_watch":
      return `on change under ${trigger.path ?? "any path"}`;
    case "branch_watch":
      return `on branch ${trigger.branch ?? "any branch"} change`;
    default:
      return "unknown trigger";
  }
}

/**
 * Automation surface (Phase 8): create, enable/disable, and remove scheduled
 * tasks, and inspect run history. The registries are props; the scheduler
 * loop and executor live elsewhere.
 */
export function AutomationPanel({
  schedule,
  setSchedule,
  history,
  onClose,
}: {
  schedule: ScheduledTaskRegistry;
  setSchedule: (next: ScheduledTaskRegistry | ((prev: ScheduledTaskRegistry) => ScheduledTaskRegistry)) => void;
  history: AutomationHistory;
  onClose: () => void;
}) {
  const tasks = Object.values(schedule.tasks);
  const dialogRef = useModalDialog(onClose);
  const [name, setName] = useState("");
  const [project, setProject] = useState("");
  const [kind, setKind] = useState<Trigger["kind"]>("interval");
  // Numeric fields stay as raw strings so the inputs can be cleared while typing.
  const [intervalMinutes, setIntervalMinutes] = useState("30");
  const [hour, setHour] = useState("9");
  const [minute, setMinute] = useState("0");
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addTask = () => {
    setError(null);
    if (!name.trim()) {
      setError("Give the task a name first.");
      return;
    }
    let trigger: Trigger;
    switch (kind) {
      case "interval": {
        const minutes = Number(intervalMinutes);
        if (!intervalMinutes.trim() || !Number.isFinite(minutes) || minutes <= 0) {
          setError("Interval must be a positive number of minutes.");
          return;
        }
        trigger = { kind: "interval", intervalMs: Math.round(minutes * 60_000) };
        break;
      }
      case "daily": {
        const h = Number(hour);
        const m = Number(minute);
        if (
          !hour.trim() ||
          !minute.trim() ||
          !Number.isInteger(h) ||
          h < 0 ||
          h > 23 ||
          !Number.isInteger(m) ||
          m < 0 ||
          m > 59
        ) {
          setError("Daily time must be a valid UTC hour and minute.");
          return;
        }
        trigger = { kind: "daily", hour: h, minute: m };
        break;
      }
      case "file_watch":
        if (!path.trim()) {
          setError("File watch needs a path prefix.");
          return;
        }
        trigger = { kind: "file_watch", path: path.trim() };
        break;
      case "branch_watch":
        if (!branch.trim()) {
          setError("Branch watch needs a branch name.");
          return;
        }
        trigger = { kind: "branch_watch", branch: branch.trim() };
        break;
      default:
        setError("Unknown trigger kind.");
        return;
    }
    const task: ScheduledTask = {
      id: newScheduledTaskId(),
      name: name.trim(),
      enabled: true,
      trigger,
      project: project.trim() || undefined,
      runCount: 0,
    };
    setSchedule((prev) => registerScheduledTask(prev, task));
    setName("");
  };

  // Newest last; the panel shows the most recent runs at the bottom of the list.
  const runs = [...history.runs].slice(-20);

  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-[var(--scrim)] p-6" onMouseDown={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="automation-title" className="modal-surface w-full max-w-lg p-5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 id="automation-title" className="text-[15px] font-semibold tracking-tight">Automation</h2>
          <button onClick={onClose} className="rounded-lg border border-line px-2 py-1 text-[12.5px] hover:border-accent">
            Close
          </button>
        </div>

        <div className="mt-4 border-t border-line pt-3">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">Scheduled tasks</div>
          {tasks.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-dim">No scheduled tasks yet.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {tasks.map((t) => (
                <li key={t.id} className="rounded-lg border border-line bg-bg/40 px-2.5 py-1.5 text-[12.5px]">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setSchedule((prev) => setScheduledTaskEnabled(prev, t.id, !t.enabled))}
                      title={t.enabled ? "Disable" : "Enable"}
                      className={`pill ${t.enabled ? "bg-ok/10 text-ok" : "bg-raised text-dim"}`}
                    >
                      {t.enabled ? "on" : "off"}
                    </button>
                    <span className={`font-semibold ${t.enabled ? "" : "text-dim"}`}>{t.name}</span>
                    <span className="text-dim">· {describeTrigger(t.trigger)}</span>
                    <button
                      onClick={() => setSchedule((prev) => removeScheduledTask(prev, t.id))}
                      className="ml-auto rounded-md border border-line px-2 py-0.5 text-[11.5px] hover:border-err hover:text-err"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-dim">
                    {t.project ? <span>{t.project}</span> : null}
                    <span>{t.runCount} runs</span>
                    {t.lastRunAt !== undefined ? <span>last {new Date(t.lastRunAt).toLocaleTimeString()}</span> : <span>never ran</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 border-t border-line pt-3">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">New task</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name, e.g. Dependency check"
              className="w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
            />
            <input
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="Project (optional)"
              className="w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
            />
          </div>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Trigger["kind"])}
            className="mt-2 w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
          >
            <option value="interval">On an interval</option>
            <option value="daily">Daily at a UTC time</option>
            <option value="file_watch">When files change</option>
            <option value="branch_watch">When a branch changes</option>
          </select>
          {kind === "interval" ? (
            <input
              type="number"
              min={1}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(e.target.value)}
              placeholder="Every N minutes"
              className="mt-2 w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
            />
          ) : null}
          {kind === "daily" ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input
                type="number"
                min={0}
                max={23}
                value={hour}
                onChange={(e) => setHour(e.target.value)}
                placeholder="UTC hour"
                className="w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
              />
              <input
                type="number"
                min={0}
                max={59}
                value={minute}
                onChange={(e) => setMinute(e.target.value)}
                placeholder="Minute"
                className="w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
              />
            </div>
          ) : null}
          {kind === "file_watch" ? (
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="Path prefix, e.g. src/"
              className="mt-2 w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
            />
          ) : null}
          {kind === "branch_watch" ? (
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="Branch name (empty = any branch)"
              className="mt-2 w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
            />
          ) : null}
          {error ? <p className="mt-2 text-[12px] text-err">{error}</p> : null}
          <button
            onClick={addTask}
            className="mt-2 w-full rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg hover:opacity-90"
          >
            Schedule task
          </button>
        </div>

        <div className="mt-4 border-t border-line pt-3">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">Run history</div>
          {runs.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-dim">Nothing has run yet.</p>
          ) : (
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
              {runs.map((run) => (
                <li key={run.id} className="flex items-center gap-2 text-[12px]">
                  <span className={run.status === "succeeded" ? "text-ok" : "text-err"}>
                    {run.status === "succeeded" ? "ok" : "failed"}
                  </span>
                  <span className="text-fg/80">{run.taskName}</span>
                  {run.error ? <span className="text-dim">· {run.error}</span> : null}
                  {run.contractPassed === false ? <span className="pill bg-err/10 text-err">contract failed</span> : null}
                  <span className="ml-auto text-dim">{new Date(run.startedAt).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
