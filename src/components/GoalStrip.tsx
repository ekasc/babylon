import { useEffect, useState } from "react";
import { durableGoalElapsed, formatDurableElapsed, type DurableGoalState } from "../lib/durable-goal";

// A mini strip joined to the top of the composer: the durable goal's
// objective, status, live clock and turn count, with pause / resume / stop
// inline. It only renders while a goal exists (or one is being named), so
// the composer is bare otherwise; creation starts from the ghost Goal
// control in the composer row. State comes from the hardbaked goal-mode
// extension (`/goal …`), never local storage — this strip is a view over
// the same goal the agent enforces.
export function GoalStrip({
  goal,
  editing,
  onEditingChange,
  onStart,
  onPause,
  onResume,
  onFinish,
  onClear,
}: {
  goal: DurableGoalState | null;
  editing: boolean;
  onEditingChange(editing: boolean): void;
  onStart(objective: string): void;
  onPause(): void;
  onResume(): void;
  onFinish(): void;
  onClear(): void;
}) {
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const running = !!goal && goal.active && !goal.paused;
  const finished = !!goal && !goal.active;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, goal?.startedAt]);

  if (!goal && !editing) return null;

  const submit = () => {
    const clean = draft.trim();
    if (!clean) return;
    onStart(clean);
    setDraft("");
    onEditingChange(false);
  };
  const cancel = () => {
    setDraft("");
    onEditingChange(false);
  };
  const newGoal = () => {
    onClear();
    setDraft("");
    onEditingChange(true);
  };

  const turns = goal?.turnCount ?? 0;
  // Executing is the quiet steady state; every other status earns its word.
  const statusWord =
    !goal || (goal.active && !goal.paused && goal.status === "executing")
      ? null
      : !goal.active
        ? goal.status === "cancelled"
          ? "cancelled"
          : "done"
        : goal.paused
          ? "paused"
          : goal.status;

  return (
    <div className="goal-strip" aria-label={goal ? `Goal: ${goal.objective}` : "New goal"}>
      {goal == null ? (
        <>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") cancel();
            }}
            placeholder="Name the objective…"
            aria-label="Goal objective"
            className="settings-input goal-strip-input"
          />
          <button type="button" onClick={submit} disabled={!draft.trim()} className="thread-action thread-action-text text-[12px]">
            Start
          </button>
          <button type="button" onClick={cancel} className="thread-action thread-action-text text-[12px]">
            Cancel
          </button>
        </>
      ) : (
        <>
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${finished ? "bg-dim" : goal.paused ? "bg-warn" : "bg-ok"}`}
          />
          <span className="goal-objective" title={goal.currentStep ? `${goal.objective}\n${goal.currentStep}` : goal.objective}>
            {goal.objective}
          </span>
          <span className="shrink-0 tabular-nums">{formatDurableElapsed(durableGoalElapsed(goal, now))}</span>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="shrink-0">
            {turns} {turns === 1 ? "turn" : "turns"}
          </span>
          {statusWord ? (
            <span className="shrink-0">{statusWord}</span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center">
            {finished ? (
              <>
                <button type="button" onClick={onResume} className="thread-action thread-action-text text-[12px]">
                  Continue
                </button>
                <button type="button" onClick={newGoal} className="thread-action thread-action-text text-[12px]">
                  New goal
                </button>
              </>
            ) : goal.paused ? (
              <>
                <button type="button" onClick={onResume} className="thread-action thread-action-text text-[12px]">
                  Resume
                </button>
                <button type="button" onClick={onFinish} className="thread-action thread-action-text text-[12px]">
                  Stop
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={onPause} className="thread-action thread-action-text text-[12px]">
                  Pause
                </button>
                <button type="button" onClick={onFinish} className="thread-action thread-action-text text-[12px]">
                  Stop
                </button>
              </>
            )}
          </span>
        </>
      )}
    </div>
  );
}
