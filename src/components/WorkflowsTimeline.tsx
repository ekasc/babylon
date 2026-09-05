import { useState } from "react";
import { fmtTokens } from "../store";
import {
  type WorkflowAgentDetail,
  type WorkflowControlAction,
  type WorkflowRunDetail,
} from "../bridge";
import {
  ChevronIcon,
  LayersIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
} from "./icons";

/*
 * WorkflowsTimeline, flat brutalist pipeline visualization for a single
 * workflow run. Renders the run's phases as a connected stage graph (each stage
 * carries one of pending / running / paused / done, plus failed / aborted for
 * terminal runs), a segmented phase-progress bar, the agents grouped by phase,
 * the run log, and the pause/resume/stop/delete controls.
 *
 * Drop-in replacement for RunDetailView: same prop shape.
 */

type StageStatus = "pending" | "running" | "paused" | "done" | "failed" | "aborted";

const STAGE: Record<StageStatus, { label: string; color: string }> = {
  pending: { label: "Pending", color: "var(--dim)" },
  running: { label: "Running", color: "var(--accent)" },
  paused: { label: "Paused", color: "var(--warn)" },
  done: { label: "Done", color: "var(--ok)" },
  failed: { label: "Failed", color: "var(--err)" },
  aborted: { label: "Aborted", color: "var(--dim)" },
};

const TOOL_PREVIEW_LIMIT = 400;

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtDuration(ms?: number): string {
  if (ms == null) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtCost(t?: { cost?: number }): string {
  if (!t || t.cost == null) return "";
  return `$${t.cost < 0.01 ? t.cost.toFixed(4) : t.cost.toFixed(2)}`;
}

function clampText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Derive a per-stage status from the run status + current-phase pointer. */
function stageStatus(run: WorkflowRunDetail, index: number): StageStatus {
  const phaseIdx = run.currentPhase ? run.phases.indexOf(run.currentPhase) : -1;
  const status = run.status;
  if (status === "completed") return "done";
  if (status === "failed") {
    if (phaseIdx === -1) return "failed";
    return index < phaseIdx ? "done" : index === phaseIdx ? "failed" : "pending";
  }
  if (status === "aborted") {
    if (phaseIdx === -1) return "aborted";
    return index < phaseIdx ? "done" : index === phaseIdx ? "aborted" : "pending";
  }
  // pending / running / paused
  if (phaseIdx === -1) return status === "paused" ? "paused" : "pending";
  if (index < phaseIdx) return "done";
  if (index > phaseIdx) return "pending";
  return status === "paused" ? "paused" : "running";
}

const AGENT_STATUS_COLOR: Record<string, string> = {
  queued: "var(--dim)",
  running: "var(--accent)",
  retrying: "var(--warn)",
  done: "var(--ok)",
  error: "var(--err)",
  skipped: "var(--dim)",
};

export function WorkflowsTimeline({
  run,
  onControl,
  onDelete,
  onOpenAgent,
}: {
  run: WorkflowRunDetail;
  onControl(action: WorkflowControlAction, runId: string): void;
  onDelete(runId: string): void;
  onOpenAgent(a: WorkflowAgentDetail): void;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const meta = STAGE[stageStatus(run, run.currentPhase ? run.phases.indexOf(run.currentPhase) : -1)] ?? STAGE.pending;
  const terminal = run.status === "completed" || run.status === "failed" || run.status === "aborted";
  const foreign = !run.sessionId;
  const agents = run.agents ?? [];
  const doneAgents = agents.filter((a) => a.status === "done" || a.status === "error" || a.status === "skipped").length;
  const toks = run.tokenUsage?.total;
  const cost = fmtCost(run.tokenUsage);

  const ctrlBtn =
    "flex items-center gap-1 border px-2 py-1 text-[14px] font-medium tracking-[0.01em] transition-colors";

  // Group agents by their declared phase (in phase order), then a trailing
  // group for any agent whose phase isn't in the run's phase list.
  const grouped = run.phases.map((p) => ({
    phase: p,
    items: agents.filter((a) => a.phase === p),
  }));
  const ungrouped = agents.filter((a) => !a.phase || !run.phases.includes(a.phase));
  if (ungrouped.length) grouped.push({ phase: "Agents", items: ungrouped });

  const completedStages = run.phases.filter((_, i) => stageStatus(run, i) === "done").length;

  return (
    <div className="flex flex-col gap-3">
      {/* Header + controls */}
      <div className="border border-line-strong bg-bg">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <LayersIcon size={14} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight text-fg">
            {run.workflowName}
          </span>
          <span
            className="shrink-0 px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-[0.06em]"
            style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 16%, var(--bg))`, border: `1px solid ${meta.color}` }}
          >
            {meta.label}
          </span>
        </div>

        {run.description && (
          <p className="px-3 py-1.5 text-[14px] leading-snug text-dim">{run.description}</p>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-[14px] tracking-[0.02em] text-dim">
          {run.script && <span className="rounded-sm border border-line bg-inset px-1.5 py-px font-mono text-[12px] text-dim">{run.script}</span>}
          {run.startedAt ? <span>started {timeAgo(run.startedAt)}</span> : null}
          {run.completedAt ? <span>finished {timeAgo(run.completedAt)}</span> : null}
          {run.durationMs != null ? <span>took {fmtDuration(run.durationMs)}</span> : null}
          {toks != null ? <span>{fmtTokens(toks)} tok</span> : null}
          {cost ? <span>{cost}</span> : null}
          <span className="ml-auto">{run.sessionId ? "this session" : "another session"}</span>
        </div>

        {run.pauseReason && (
          <p className="border-t border-line px-3 py-1.5 text-[14px] leading-snug text-warn">
            Paused: {run.pauseReason}
            {run.resetHint ? `, ${run.resetHint}` : ""}
          </p>
        )}
        {run.error && (
          <p className="border-t border-line px-3 py-1.5 text-[14px] leading-snug text-err">
            {run.error}
            {run.errorCode ? <span className="ml-1 font-mono text-[14px] opacity-80">[{run.errorCode}]</span> : null}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
          {terminal ? (
            <button
              onClick={() => onDelete(run.runId)}
              className={`${ctrlBtn} border-line text-dim hover:border-err/50 hover:text-err`}
              title="Remove this run's on-disk state"
            >
              Delete
            </button>
          ) : foreign ? (
            <span
              className="border border-line px-2 py-1 text-[14px] text-dim opacity-70"
              title="This run was started in another pi session, control it from there"
            >
              read-only · other session
            </span>
          ) : (
            <>
              {(run.status === "pending" || run.status === "running") && (
                <button
                  onClick={() => onControl("pause", run.runId)}
                  className={`${ctrlBtn} border-line text-dim hover:border-warn/60 hover:text-warn`}
                  title="Pause this run"
                >
                  <PauseIcon size={10} />
                  Pause
                </button>
              )}
              {run.status === "paused" && (
                <button
                  onClick={() => onControl("resume", run.runId)}
                  className={`${ctrlBtn} border-line text-dim hover:border-ok/60 hover:text-ok`}
                  title="Resume this run"
                >
                  <PlayIcon size={10} />
                  Resume
                </button>
              )}
              {(run.status === "pending" || run.status === "running" || run.status === "paused") && (
                <button
                  onClick={() => onControl("stop", run.runId)}
                  className={`${ctrlBtn} border-line text-dim hover:border-err/60 hover:text-err`}
                  title="Stop this run"
                >
                  <StopIcon size={10} />
                  Stop
                </button>
              )}
            </>
          )}
          <span className="ml-auto font-mono text-[14px] text-dim">{run.runId.slice(0, 8)}…</span>
        </div>
      </div>

      {/* Pipeline stage graph */}
      {run.phases.length > 0 ? (
        <div>
          <div className="mb-1.5 flex items-baseline justify-between px-1">
            <span className="text-[14px] font-semibold text-dim">Pipeline</span>
            <span className="text-[14px] tracking-[0.02em] text-dim">
              {completedStages}/{run.phases.length} stages · {doneAgents}/{agents.length} agents
            </span>
          </div>

          {/* Segmented progress bar */}
          <div className="mb-2 flex h-1.5 w-full overflow-hidden border border-line">
            {run.phases.map((_, i) => {
              const st = stageStatus(run, i);
              const c = STAGE[st].color;
              return (
                <div
                  key={i}
                  className="h-full flex-1"
                  style={{ background: st === "pending" ? "var(--inset)" : c, borderRight: i < run.phases.length - 1 ? "1px solid var(--line)" : "none" }}
                  title={`Stage ${i + 1}: ${STAGE[st].label}`}
                />
              );
            })}
          </div>

          <div className="overflow-x-auto">
            <div className="flex min-w-min items-stretch gap-0 pb-1">
              {run.phases.map((p, i) => {
                const st = stageStatus(run, i);
                const c = STAGE[st].color;
                const phaseAgents = agents.filter((a) => a.phase === p);
                const isCurrent = st === "running" || st === "paused";
                return (
                  <div key={p} className="flex items-stretch">
                    <div
                      className="flex w-[148px] shrink-0 flex-col border bg-bg"
                      style={{ borderColor: c, borderWidth: isCurrent ? 2 : 1.5, background: `color-mix(in srgb, ${c} 8%, var(--bg))` }}
                    >
                      <div className="flex items-center gap-1.5 border-b px-2 py-1.5" style={{ borderColor: c }}>
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${st === "running" ? "animate-pulse" : ""}`}
                          style={{ background: c }}
                        />
                        <span className="font-mono text-[11px] text-dim">{String(i + 1).padStart(2, "0")}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-fg" title={p}>
                          {p}
                        </span>
                      </div>
                      <div className="flex items-center justify-between px-2 py-1.5">
                        <span className="text-[12px] font-medium uppercase tracking-[0.06em]" style={{ color: c }}>
                          {STAGE[st].label}
                        </span>
                        <span className="text-[12px] text-dim">
                          {phaseAgents.length > 0 ? `${phaseAgents.length} agent${phaseAgents.length === 1 ? "" : "s"}` : ","}
                        </span>
                      </div>
                    </div>
                    {i < run.phases.length - 1 && (
                      <div className="flex w-5 shrink-0 items-center justify-center">
                        <span style={{ color: stageStatus(run, i) === "done" ? "var(--ok)" : "var(--dim)" }}>
                          <ChevronIcon size={12} />
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="border border-line bg-bg px-3 py-3 text-[14px] text-dim">No pipeline stages defined.</div>
      )}

      {/* Agents grouped by phase */}
      <div>
        <div className="mb-1.5 px-1 text-[14px] font-semibold text-dim">Agents</div>
        {agents.length === 0 ? (
          <p className="px-1 py-2 text-[14px] text-dim">No agents yet, queued runs appear here once they start.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {grouped.map((g) => (
              <div key={g.phase} className="border border-line bg-bg">
                <div className="border-b border-line px-2.5 py-1 text-[13px] font-semibold tracking-tight text-fg">
                  {g.phase}
                  <span className="ml-1.5 text-[12px] font-normal text-dim">{g.items.length}</span>
                </div>
                {g.items.length === 0 ? (
                  <p className="px-2.5 py-1.5 text-[13px] text-dim">No agents in this stage yet.</p>
                ) : (
                  <div className="divide-y divide-line">
                    {g.items.map((a) => (
                      <AgentRow key={a.id} agent={a} onOpen={() => onOpenAgent(a)} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Logs */}
      {run.logs && run.logs.length > 0 && (
        <div className="border border-line bg-bg">
          <button
            onClick={() => setLogsOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] font-medium text-fg hover:bg-inset"
            aria-expanded={logsOpen}
          >
            <ChevronIcon size={12} className={`text-dim transition-transform ${logsOpen ? "rotate-90" : ""}`} />
            Logs <span className="text-dim">({run.logs.length})</span>
          </button>
          {logsOpen && (
            <div className="flex max-h-60 flex-col gap-0.5 overflow-y-auto border-t border-line px-3 py-2 font-mono text-[13px] leading-relaxed text-dim">
              {run.logs.map((l, i) => (
                <span key={i} className="whitespace-pre-wrap break-words">
                  {clampText(l, TOOL_PREVIEW_LIMIT)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AgentRow({ agent, onOpen }: { agent: WorkflowAgentDetail; onOpen(): void }) {
  const color = AGENT_STATUS_COLOR[agent.status] ?? "var(--dim)";
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-inset"
      title="Open agent detail"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${agent.status === "running" ? "animate-pulse" : ""}`} style={{ background: color }} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-[13px] text-dim">#{agent.id}</span>
          <span className="truncate text-[14px] font-medium tracking-tight text-fg">{agent.label}</span>
        </span>
        {(agent.error || agent.waitReason) && (
          <span className={`mt-0.5 block truncate text-[13px] ${agent.error ? "text-err" : "text-warn"}`}>
            {agent.error ?? agent.waitReason}
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-[13px] font-medium tracking-[0.02em]" style={{ color }}>
          {agent.status}
        </span>
        <span className="block text-[13px] tracking-[0.02em] text-dim">
          {[agent.model ? agent.model.split("/").pop() : "", agent.tokens != null ? `${fmtTokens(agent.tokens)} tok` : ""]
            .filter(Boolean)
            .join(" · ") || ","}
        </span>
      </span>
      <ChevronIcon size={12} className="shrink-0 rotate-180 text-dim" />
    </button>
  );
}
