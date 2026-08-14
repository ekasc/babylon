import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFlipList } from "../flip";
import {
  bridge,
  type ActivityUpdate,
  type SubagentActivity,
  type ThreadActivity,
  type WorkflowAgentDetail,
  type WorkflowControlAction,
  type WorkflowHistoryEntry,
  type WorkflowRunDetail,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowTokenUsage,
} from "../bridge";
import { fmtTokens } from "../store";
import Markdown from "./Markdown";
import {
  ChevronIcon,
  LayersIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  StopIcon,
  XIcon,
} from "./icons";

interface Props {
  onClose(): void;
  onOpenSession?(path: string, cwd?: string, parentPath?: string): void;
  toast(type: "info" | "warning" | "error", text: string): void;
}

type ActivityTab = "workflows" | "agents";

type AgentItem =
  | { kind: "thread"; thread: ThreadActivity }
  | { kind: "subagent"; run: SubagentActivity };

const RUN_STATUS: Record<WorkflowRunStatus, { label: string; dot: string; text: string }> = {
  pending: { label: "Pending", dot: "bg-dim", text: "text-dim" },
  running: { label: "Running", dot: "bg-accent animate-pulse", text: "text-accent" },
  paused: { label: "Paused", dot: "bg-warn", text: "text-warn" },
  completed: { label: "Completed", dot: "bg-ok", text: "text-ok" },
  failed: { label: "Failed", dot: "bg-err", text: "text-err" },
  aborted: { label: "Aborted", dot: "bg-dim", text: "text-dim" },
};

const AGENT_STATUS: Record<string, { label: string; dot: string; text: string }> = {
  queued: { label: "Queued", dot: "bg-dim", text: "text-dim" },
  running: { label: "Running", dot: "bg-accent animate-pulse", text: "text-accent" },
  retrying: { label: "Retrying", dot: "bg-warn", text: "text-warn" },
  done: { label: "Done", dot: "bg-ok", text: "text-ok" },
  error: { label: "Error", dot: "bg-err", text: "text-err" },
  skipped: { label: "Skipped", dot: "bg-dim", text: "text-dim" },
};

function active(r: WorkflowRunSummary): boolean {
  return r.status === "running" || r.status === "paused" || r.status === "pending";
}

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

function fmtCost(t?: WorkflowTokenUsage): string {
  if (!t || t.cost == null) return "";
  return `$${t.cost < 0.01 ? t.cost.toFixed(4) : t.cost.toFixed(2)}`;
}

function clampText(s: string, max = 600): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function stringifyResult(r: unknown): string {
  if (typeof r === "string") return r;
  if (r == null) return "";
  try {
    return JSON.stringify(r, null, 2);
  } catch {
    return String(r);
  }
}

export default function WorkflowsPanel({ onClose, onOpenSession, toast }: Props) {
  const [tab, setTab] = useState<ActivityTab>("workflows");
  const [activity, setActivity] = useState<ActivityUpdate>({ threads: [], subagents: [] });
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [agent, setAgent] = useState<WorkflowAgentDetail | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const detailRef = useRef(detail);
  detailRef.current = detail;
  const agentIdRef = useRef<number | null>(null);
  agentIdRef.current = agent?.id ?? null;

  const load = useCallback(async () => {
    try {
      setRuns(await bridge.workflowsList());
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message ?? "failed to load workflow runs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void bridge.activityList().then(setActivity).catch(() => undefined);
    return bridge.onActivityUpdate((next) => {
      setActivity(next);
      setSelectedAgent((current) => {
        if (!current) return null;
        if (current.kind === "thread") {
          const thread = next.threads.find((item) => item.threadId === current.thread.threadId);
          return thread ? { kind: "thread", thread } : null;
        }
        const run = next.subagents.find((item) => item.runId === current.run.runId);
        return run ? { kind: "subagent", run } : null;
      });
    });
  }, [load]);

  const refreshDetail = useCallback(
    async (runId: string) => {
      try {
        const d = await bridge.workflowsGet(runId);
        if (!d) {
          setDetail(null);
          setAgent(null);
          return;
        }
        // The run file's updatedAt is the durable revision. Always apply a
        // changed file so live token counts, logs, output and queued→running
        // transitions cannot remain stale; selection is preserved below.
        setDetail(d);
        // Keep the open agent selected across refreshes if it still exists.
        const id = agentIdRef.current;
        setAgent((prevA) => {
          if (!id || !prevA) return prevA;
          return d.agents?.find((a) => a.id === id) ?? prevA;
        });
      } catch {
        /* transient — next poll tick will retry */
      }
    },
    []
  );

  // Live updates from the bridge poll loop. When the run currently open in
  // the detail view changed (updatedAt moved), re-fetch it.
  useEffect(
    () =>
      bridge.onWorkflowsUpdate(({ runs: next }) => {
        setRuns(next);
        const open = detailRef.current;
        if (!open) return;
        const s = next.find((r) => r.runId === open.runId);
        if (!s) {
          setDetail(null);
          setAgent(null);
        } else if (s.updatedAt !== open.updatedAt) {
          void refreshDetail(open.runId);
        }
      }),
    [refreshDetail]
  );

  const openRun = useCallback(
    async (runId: string) => {
      try {
        const d = await bridge.workflowsGet(runId);
        if (!d) {
          toast("warning", "run no longer exists");
          return;
        }
        setDetail(d);
        setAgent(null);
      } catch (e: any) {
        toast("error", e?.message ?? "failed to load run");
      }
    },
    [toast]
  );

  const control = useCallback(
    async (action: WorkflowControlAction, runId: string) => {
      try {
        await bridge.workflowsControl(action, runId);
        // Optimistic status flip; the poll push corrects any drift.
        setRuns((rs) =>
          rs.map((r) =>
            r.runId === runId
              ? {
                  ...r,
                  status:
                    action === "pause" ? "paused" : action === "resume" ? "running" : action === "stop" ? "aborted" : r.status,
                }
              : r
          )
        );
        const open = detailRef.current;
        if (open && open.runId === runId) {
          setDetail({
            ...open,
            status:
              action === "pause" ? "paused" : action === "resume" ? "running" : action === "stop" ? "aborted" : open.status,
          });
        }
        void load();
      } catch (e: any) {
        toast("error", e?.message ?? `${action} failed`);
      }
    },
    [load, toast]
  );

  const remove = useCallback(
    async (runId: string) => {
      if (!window.confirm("Delete this workflow run?\n\nIts on-disk run state (including agent logs) will be removed.")) {
        return;
      }
      try {
        await bridge.workflowsDelete(runId);
        setDetail(null);
        setAgent(null);
        void load();
        toast("info", "run deleted");
      } catch (e: any) {
        toast("error", e?.message ?? "delete failed");
      }
    },
    [load, toast]
  );

  const back = useCallback(() => {
    if (agent) setAgent(null);
    else if (detail) setDetail(null);
    else if (selectedAgent) setSelectedAgent(null);
    else onClose();
  }, [agent, detail, selectedAgent, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (agent || detail || selectedAgent) back();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agent, detail, selectedAgent, back, onClose]);

  const live = useMemo(
    () =>
      runs.some(active) ||
      activity.threads.some((thread) => ["queued", "starting", "running", "interrupting"].includes(thread.status)) ||
      activity.subagents.some((subagent) => subagent.status === "running"),
    [runs, activity]
  );

  return (
    <section aria-label="Activity workspace" className="context-pane flex h-full min-w-0 flex-col">
      {/* Header */}
      <div className="context-header flex h-16 shrink-0 items-center gap-2 px-4">
        {(agent || detail || selectedAgent) && (
          <button
            onClick={back}
            title="Back"
            className="rounded-md px-1 py-0.5 text-dim hover:bg-inset hover:text-fg"
          >
            <ChevronIcon size={14} className="rotate-180" />
          </button>
        )}
        <LayersIcon size={14} className="shrink-0 text-accent" />
        <span className="text-[14px] font-semibold tracking-tight">Activity</span>
        {live ? <span className="h-2 w-2 rounded-full bg-accent" title="Work is active" /> : null}
        <span className="truncate text-[14px] tracking-[0.02em] text-dim">
          {tab === "agents" ? selectedAgent ? "agent transcript" : "subagents · threads" : agent ? "agent transcript" : detail ? "run detail" : "workflows · agents"}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {!agent && !detail && (
            <button
              onClick={() => {
                void load();
                void bridge.activityList().then(setActivity);
              }}
              title="Refresh"
              className="rounded-md px-1.5 py-0.5 text-dim hover:bg-inset hover:text-fg"
            >
              <RefreshIcon size={12} />
            </button>
          )}
          <button
            onClick={onClose}
            title="Close"
            className="rounded-md px-1.5 py-0.5 text-dim hover:bg-inset hover:text-fg"
          >
            <XIcon size={12} />
          </button>
        </div>
      </div>

      <div className="operator-inspector-tabs grid shrink-0 grid-cols-2 px-4">
        {(["workflows", "agents"] as const).map((value) => (
          <button
            key={value}
            onClick={() => {
              setTab(value);
              setAgent(null);
              setDetail(null);
              setSelectedAgent(null);
            }}
            className={`px-2 py-2.5 text-[14px] font-semibold capitalize tracking-wide ${tab === value ? "is-active" : ""}`}
          >
            {value} · {value === "workflows" ? runs.length : activity.threads.length + activity.subagents.length}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="context-content min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === "agents" ? (
          selectedAgent ? (
            <AgentDetail item={selectedAgent} toast={toast} onOpenSession={onOpenSession} onUpdate={setSelectedAgent} />
          ) : (
            <AgentsView threads={activity.threads} subagents={activity.subagents} onOpen={setSelectedAgent} />
          )
        ) : loading ? (
          <p className="px-2 py-8 text-center text-[14px] text-dim">Loading runs…</p>
        ) : loadError ? (
          <p className="rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-[14px] leading-relaxed text-err">
            {loadError}
          </p>
        ) : agent ? (
          <AgentView agent={agent} />
        ) : detail ? (
          <RunDetailView run={detail} onControl={control} onDelete={remove} onOpenAgent={setAgent} />
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
            <LayersIcon size={30} className="text-dim" />
            <div>
              <p className="text-[14px] font-medium text-fg">No workflow runs yet</p>
              <p className="mt-1 text-[14px] leading-relaxed text-dim">
                Run a workflow from pi to see it here.
              </p>
            </div>
          </div>
        ) : (
          <RunList runs={runs} onOpen={openRun} />
        )}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
   Level 1 — runs list
--------------------------------------------------------------------------- */
function RunList({ runs, onOpen }: { runs: WorkflowRunSummary[]; onOpen(runId: string): void }) {
  return (
    <div className="flex flex-col gap-1.5">
      {runs.map((r) => {
        const meta = RUN_STATUS[r.status] ?? RUN_STATUS.pending;
        const nAgents = r.agents?.length ?? 0;
        const nPhases = r.phases.length;
        const toks = r.tokenUsage?.total;
        const cost = fmtCost(r.tokenUsage);
        const metaParts = [
          nAgents > 0 ? `${nAgents} agent${nAgents === 1 ? "" : "s"}` : "",
          nPhases > 0 ? `${nPhases} phase${nPhases === 1 ? "" : "s"}` : "",
          toks != null && toks > 0 ? `${fmtTokens(toks)} tok` : "",
          cost,
        ].filter(Boolean);
        return (
          <button
            key={r.runId}
            onClick={() => onOpen(r.runId)}
            className="activity-row group flex w-full items-start gap-2.5 px-2.5 py-3 text-left"
            title={`${r.workflowName} — ${meta.label}`}
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-[14px] font-semibold tracking-tight text-fg">
                  {r.workflowName}
                </span>
                <span className={`shrink-0 text-[14px] font-medium tracking-[0.02em] ${meta.text}`}>
                  {meta.label}
                </span>
              </span>
              {r.description && (
                <span className="mt-0.5 block truncate text-[14px] text-dim">{r.description}</span>
              )}
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[14px] tracking-[0.02em] text-dim">
                {metaParts.length > 0 && <span>{metaParts.join(" · ")}</span>}
                {r.currentPhase && (
                  <span className="rounded bg-accent-soft px-1 py-px font-medium text-accent">
                    {r.currentPhase}
                  </span>
                )}
                <span className="ml-auto shrink-0">{timeAgo(r.updatedAt ?? r.startedAt)}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Level 2 — run detail (phases + agents + controls)
--------------------------------------------------------------------------- */
export function RunDetailView({
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
  const meta = RUN_STATUS[run.status] ?? RUN_STATUS.pending;
  const terminal = run.status === "completed" || run.status === "failed" || run.status === "aborted";
  const foreign = !run.sessionId; // legacy/global run: not controllable from this session
  const phaseIdx = run.currentPhase ? run.phases.indexOf(run.currentPhase) : -1;
  const toks = run.tokenUsage?.total;
  const cost = fmtCost(run.tokenUsage);
  const agents = run.agents ?? [];
  const doneAgents = agents.filter((a) => a.status === "done" || a.status === "error" || a.status === "skipped").length;

  const ctrlBtn =
    "flex items-center gap-1 rounded-md border px-2 py-1 text-[14px] font-medium tracking-[0.01em] transition-colors";

  return (
    <div className="flex flex-col gap-3">
      {/* Run header */}
      <div className="rounded-lg border border-line/60 bg-bg/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight text-fg">
            {run.workflowName}
          </span>
          <span className={`shrink-0 text-[14px] font-medium tracking-[0.02em] ${meta.text}`}>{meta.label}</span>
        </div>
        {run.description && <p className="mt-1 text-[14px] leading-snug text-dim">{run.description}</p>}
        <p className="mt-1.5 text-[14px] tracking-[0.02em] text-dim">
          {[
            run.startedAt ? `started ${timeAgo(run.startedAt)}` : "",
            run.completedAt ? `finished ${timeAgo(run.completedAt)}` : "",
            run.durationMs != null ? `took ${fmtDuration(run.durationMs)}` : "",
            toks != null ? `${fmtTokens(toks)} tok` : "",
            cost,
            run.sessionId ? "this session" : "another session",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {run.pauseReason && (
          <p className="mt-1.5 rounded-md border border-warn/30 bg-warn/10 px-2 py-1 text-[14px] leading-snug text-warn">
            Paused: {run.pauseReason}
            {run.resetHint ? ` — ${run.resetHint}` : ""}
          </p>
        )}
        {run.error && (
          <p className="mt-1.5 rounded-md border border-err/30 bg-err/10 px-2 py-1 text-[14px] leading-snug text-err">
            {run.error}
            {run.errorCode ? <span className="ml-1 font-mono text-[14px] opacity-80">[{run.errorCode}]</span> : null}
          </p>
        )}

        {/* Controls */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line/40 pt-2">
          {terminal ? (
            <button
              onClick={() => onDelete(run.runId)}
              className={`${ctrlBtn} border-line/60 text-dim hover:border-err/40 hover:text-err`}
              title="Remove this run's on-disk state"
            >
              Delete
            </button>
          ) : foreign ? (
            <span
              className="cursor-default rounded-md border border-line/40 px-2 py-1 text-[14px] text-dim opacity-70"
              title="This run was started in another pi session — control it from there"
            >
              read-only · other session
            </span>
          ) : (
            <>
              {(run.status === "pending" || run.status === "running") && (
                <button
                  onClick={() => onControl("pause", run.runId)}
                  className={`${ctrlBtn} border-line/60 text-dim hover:border-warn/50 hover:text-warn`}
                  title="Pause this run"
                >
                  <PauseIcon size={10} />
                  Pause
                </button>
              )}
              {run.status === "paused" && (
                <button
                  onClick={() => onControl("resume", run.runId)}
                  className={`${ctrlBtn} border-line/60 text-dim hover:border-ok/50 hover:text-ok`}
                  title="Resume this run"
                >
                  <PlayIcon size={10} />
                  Resume
                </button>
              )}
              {(run.status === "pending" || run.status === "running" || run.status === "paused") && (
                <button
                  onClick={() => onControl("stop", run.runId)}
                  className={`${ctrlBtn} border-line/60 text-dim hover:border-err/50 hover:text-err`}
                  title="Stop this run"
                >
                  <StopIcon size={10} />
                  Stop
                </button>
              )}
            </>
          )}
          <span className="ml-auto text-[14px] tracking-[0.02em] text-dim">
            {run.runId.slice(0, 8)}…
          </span>
        </div>
      </div>

      {/* Phases */}
      {run.phases.length > 0 && (
        <div>
          <SectionLabel>Phases</SectionLabel>
          <div className="flex flex-col gap-1">
            {run.phases.map((p, i) => {
              const state = phaseIdx < 0 ? (run.status === "completed" ? "done" : "dim") : i < phaseIdx ? "done" : i === phaseIdx ? "cur" : "dim";
              return (
                <div
                  key={p}
                  className={`flex items-center gap-2 rounded-md border px-2 py-1 text-[14px] ${
                    state === "cur"
                      ? "border-accent/40 bg-accent-soft text-fg"
                      : state === "done"
                        ? "border-line/40 text-dim"
                        : "border-line/30 text-dim opacity-70"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      state === "cur" ? "bg-accent" : state === "done" ? "bg-ok" : "bg-dim"
                    }`}
                  />
                  <span className="truncate">{p}</span>
                  {state === "cur" && <span className="ml-auto text-[14px] font-semibold tracking-[0.02em] text-accent">now</span>}
                  {state === "done" && <span className="ml-auto text-[14px] tracking-[0.02em] text-dim">done</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Agents */}
      <div>
        <SectionLabel>
          Agents
          {agents.length > 0 && (
            <span className="text-dim">
              {" "}
              · {doneAgents}/{agents.length} done
            </span>
          )}
        </SectionLabel>
        {agents.length === 0 ? (
          <p className="px-1 py-2 text-[14px] text-dim">No agents yet — queued runs appear here once they start.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {agents.map((a) => (
              <AgentRow key={a.id} agent={a} onOpen={() => onOpenAgent(a)} />
            ))}
          </div>
        )}
      </div>

      {/* Logs */}
      {run.logs && run.logs.length > 0 && (
        <details className="rounded-lg border border-line/50 bg-bg/40 px-2.5 py-1.5">
          <summary className="cursor-pointer select-none text-[14px] font-medium text-dim hover:text-fg">
            Logs ({run.logs.length})
          </summary>
          <div className="mt-1.5 flex max-h-56 flex-col gap-1 overflow-y-auto border-t border-line/30 pt-1.5 font-mono text-[14px] leading-relaxed text-dim">
            {run.logs.map((l, i) => (
              <span key={i}>{clampText(l, 400)}</span>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 px-1 text-[14px] font-semibold text-dim">{children}</p>
  );
}

function AgentRow({ agent, onOpen }: { agent: WorkflowAgentDetail; onOpen(): void }) {
  const meta = AGENT_STATUS[agent.status] ?? { label: agent.status, dot: "bg-dim", text: "text-dim" };
  return (
    <button
      onClick={onOpen}
      className="activity-row flex w-full items-center gap-2 px-2.5 py-2.5 text-left"
      title="Open agent detail"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-[14px] text-dim">#{agent.id}</span>
          <span className="truncate text-[14px] font-medium tracking-tight text-fg">{agent.label}</span>
        </span>
        {(agent.error || agent.waitReason) && (
          <span className={`mt-0.5 block truncate text-[14px] ${agent.error ? "text-err" : "text-warn"}`}>
            {agent.error ?? agent.waitReason}
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span className={`block text-[14px] font-medium tracking-[0.02em] ${meta.text}`}>{meta.label}</span>
        <span className="block text-[14px] tracking-[0.02em] text-dim">
          {[agent.model ? agent.model.split("/").pop() : "", agent.tokens != null ? `${fmtTokens(agent.tokens)} tok` : ""]
            .filter(Boolean)
            .join(" · ") || "—"}
        </span>
      </span>
      <ChevronIcon size={12} className="shrink-0 text-dim" />
    </button>
  );
}

/* ---------------------------------------------------------------------------
   Level 3 — agent detail (prompt / result / error / history)
--------------------------------------------------------------------------- */
export function AgentView({ agent }: { agent: WorkflowAgentDetail }) {
  const meta = AGENT_STATUS[agent.status] ?? { label: agent.status, dot: "bg-dim", text: "text-dim" };
  const result = stringifyResult(agent.result);
  // The prompt is stored as the agent-options object ({ label, phase, tier,
  // prompt, ... }) in real run files — extract the instruction text.
  const prompt =
    typeof agent.prompt === "string"
      ? agent.prompt.trim()
      : agent.prompt && typeof agent.prompt === "object" && typeof (agent.prompt as any).prompt === "string"
        ? ((agent.prompt as any).prompt as string).trim()
        : "";
  const promptLabel =
    typeof agent.prompt === "object" && (agent.prompt as any)?.label
      ? String((agent.prompt as any).label)
      : undefined;
  // resultPreview carries the readable markdown summary when the raw result is
  // a structured object — prefer it for display.
  const displayResult =
    typeof agent.result === "object" && typeof agent.resultPreview === "string" && agent.resultPreview.trim()
      ? agent.resultPreview.trim()
      : result;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-line/60 bg-bg/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight text-fg">
            {agent.label}
          </span>
          <span className={`shrink-0 font-mono text-[14px] text-dim`}>#{agent.id}</span>
          <span className={`shrink-0 text-[14px] font-medium tracking-[0.02em] ${meta.text}`}>{meta.label}</span>
        </div>
        <p className="mt-1.5 text-[14px] tracking-[0.02em] text-dim">
          {[
            agent.phase ? `phase: ${agent.phase}` : "",
            agent.model ?? "",
            agent.tokens != null ? `${fmtTokens(agent.tokens)} tok` : "",
            agent.attempt != null && agent.maxAttempts != null && agent.maxAttempts > 1
              ? `attempt ${agent.attempt}/${agent.maxAttempts}`
              : "",
            agent.endedAt ? `finished ${timeAgo(agent.endedAt)}` : agent.startedAt ? `started ${timeAgo(agent.startedAt)}` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      {agent.error && (
        <div className="rounded-lg border border-err/30 bg-err/10 px-3 py-2">
          <p className="text-[14px] font-semibold text-err">Error</p>
          <p className="mt-1 whitespace-pre-wrap text-[14px] leading-relaxed text-err/90">
            {clampText(agent.error, 2000)}
          </p>
          {agent.errorCode && (
            <span className="mt-1 inline-block rounded bg-err/15 px-1.5 py-px font-mono text-[14px] text-err">
              {agent.errorCode}
            </span>
          )}
        </div>
      )}

      {prompt && (
        <div>
          <SectionLabel>{promptLabel ?? "Prompt"}</SectionLabel>
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line/50 bg-bg/40 px-3 py-2 text-[14px] leading-relaxed text-fg/85">
            {clampText(prompt, 3000)}
          </div>
        </div>
      )}

      {displayResult && !agent.error && (
        <div>
          <SectionLabel>Result</SectionLabel>
          {typeof agent.result === "string" || typeof agent.resultPreview === "string" ? (
            <div className="rounded-lg border border-line/50 bg-bg/40 px-3 py-2">
              <Markdown text={displayResult} />
            </div>
          ) : (
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-line/50 bg-bg/40 px-3 py-2 font-mono text-[14px] leading-relaxed text-fg/85">
              {clampText(displayResult, 4000)}
            </pre>
          )}
        </div>
      )}

      {agent.history && agent.history.length > 0 && (
        <div>
          <SectionLabel>Transcript</SectionLabel>
          <HistoryTranscript history={agent.history} />
        </div>
      )}
    </div>
  );
}

function AgentsView({ threads, subagents, onOpen }: { threads: ThreadActivity[]; subagents: SubagentActivity[]; onOpen(item: AgentItem): void }) {
  const items: AgentItem[] = [
    ...threads.map((thread) => ({ kind: "thread" as const, thread })),
    ...subagents.map((run) => ({ kind: "subagent" as const, run })),
  ].sort(
    (a, b) =>
      Date.parse(b.kind === "thread" ? b.thread.updatedAt : b.run.updatedAt) -
      Date.parse(a.kind === "thread" ? a.thread.updatedAt : a.run.updatedAt)
  );
  if (!items.length) return <EmptyActivity icon="diamond" title="No agents yet" text="Subagents and persistent threads appear here. Spawn one from the chat." />;
  const attach = useFlipList(items.map((item) => (item.kind === "thread" ? item.thread.threadId : item.run.runId)));
  return <div className="divide-y divide-line">{items.map((item) => {
    const id = item.kind === "thread" ? item.thread.threadId : item.run.runId;
    const name = item.kind === "thread" ? (item.thread.name ?? item.thread.goal) : (item.run.name ?? item.run.requestedModel ?? "Subagent");
    const status = item.kind === "thread" ? item.thread.status : item.run.status;
    const updated = item.kind === "thread" ? item.thread.updatedAt : item.run.updatedAt;
    const live = item.kind === "thread"
      ? ["queued", "starting", "running", "interrupting"].includes(status)
      : ["starting", "running"].includes(status);
    const badge = item.kind === "thread" ? "thread" : item.run.persistent ? "persistent" : "bounded";
    const dot = live ? "bg-accent" : status === "completed" || status === "idle" ? "bg-ok" : status === "failed" || status === "routing_mismatch" ? "bg-err" : status === "blocked" ? "bg-warn" : "bg-dim";
    return <button key={id} ref={(node) => attach(node, id)} onClick={() => onOpen(item)} className="flex w-full items-start gap-3 px-2 py-3 text-left hover:bg-inset">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2"><strong className="truncate text-[14px]">{name}</strong><span className="shrink-0 rounded bg-inset px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-dim">{badge}</span></span>
        <span className="mt-1 block truncate text-[13px] text-dim">{status.replace("_", " ")} · {timeAgo(updated)}</span>
      </span>
      <ChevronIcon size={13} className="mt-1 text-dim" />
    </button>;
  })}</div>;
}

function AgentDetail({ item, toast, onOpenSession, onUpdate }: { item: AgentItem; toast(type: "info" | "warning" | "error", text: string): void; onOpenSession?(path: string, cwd?: string, parentPath?: string): void; onUpdate(item: AgentItem): void }) {
  const thread = item.kind === "thread" ? item.thread : null;
  const run = item.kind === "subagent" ? item.run : null;
  const id = thread ? thread.threadId : run!.runId;
  const status = thread ? thread.status : run!.status;
  const name = thread ? (thread.name ?? thread.goal) : (run!.name ?? run!.requestedModel ?? "Subagent");
  const live = thread
    ? ["queued", "starting", "running", "interrupting"].includes(status)
    : ["starting", "running"].includes(status);
  const badge = thread ? "thread" : run!.persistent ? "persistent" : "bounded";
  const description = thread ? thread.goal : (run!.task ?? run!.goal);
  const model = thread ? thread.model : (run!.requestedModel ?? "—");
  const profile = thread ? thread.profile : run!.profile;
  const milestones = thread ? thread.milestones : run!.milestones;
  const recent = thread ? thread.recentMessages : run!.recentMessages;
  const controllable = thread ? live : run!.controllable === true;
  const sessionFile = thread ? thread.sessionFile : run!.sessionFile;

  const control = async (action: "steer" | "follow-up" | "stop") => {
    const message = action === "stop" ? undefined : window.prompt(action === "steer" ? "Interrupt and redirect this agent" : "Send a follow-up") ?? undefined;
    if (action !== "stop" && !message?.trim()) return;
    if (action === "stop" && !window.confirm(`Stop this ${thread ? "thread" : "subagent"}?`)) return;
    try {
      if (thread) {
        const next = await bridge.threadsControl(action, id, message);
        onUpdate({ kind: "thread", thread: next });
      } else {
        const next = await bridge.subagentsControl(action, id, message);
        onUpdate({ kind: "subagent", run: next });
      }
      toast("info", action === "stop" ? "Agent stopped" : action === "steer" ? "Agent redirected" : "Follow-up sent");
    } catch (error: any) {
      toast("error", error?.message ?? `${action} failed`);
    }
  };

  const promote = async () => {
    try {
      const target = thread ? await bridge.threadsPromote(id) : await bridge.subagentsPromote(id);
      if (thread) onUpdate({ kind: "thread", thread: { ...thread, status: "stopped", latestActivity: "Opened as main session" } });
      else onUpdate({ kind: "subagent", run: { ...run!, status: "stopped", controllable: false, latestActivity: "Opened as main session" } });
      onOpenSession?.(target.sessionFile, target.cwd, target.parentSessionFile ?? undefined);
    } catch (error: any) {
      toast("error", error?.message ?? "could not open agent as a session");
    }
  };

  return <div className="px-2">
    <div className="border-b border-line pb-4">
      <div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${live ? "bg-accent" : status === "failed" || status === "routing_mismatch" ? "bg-err" : status === "blocked" ? "bg-warn" : status === "completed" || status === "idle" ? "bg-ok" : "bg-dim"}`} /><h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold">{name}</h2><span className="shrink-0 rounded bg-inset px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-dim">{badge}</span><span className="text-[13px] text-dim">{status.replace("_", " ")}</span></div>
      {description ? <p className="mt-2 text-[14px] leading-6 text-dim">{description}</p> : null}
      <p className="mt-2 text-[12px] text-dim">{model} · {profile ?? "—"} · {id.slice(0, 8)}</p>
      {milestones?.length ? <div className="mt-3 rounded-lg border border-line bg-inset/40 px-3 py-2"><span className="text-[11px] font-semibold uppercase tracking-wide text-dim">Milestones</span><ul className="mt-1 space-y-1">{milestones.map((m, index) => <li key={`${m.at}-${index}`} className="flex items-start gap-2 text-[13px]"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-ok" /><span className="min-w-0"><span className="font-medium">{m.name}</span>{m.note ? <span className="text-dim"> — {m.note}</span> : null}<span className="ml-1 text-[11px] text-dim">{new Date(m.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span></span></li>)}</ul></div> : null}
    </div>
    <div className="max-h-[46vh] overflow-y-auto py-4">
      {recent?.length ? recent.map((message, index) => <div key={`${message.at}-${index}`} className="border-l border-line py-2 pl-3"><span className="text-[12px] font-medium text-dim">{message.role}</span><p className="mt-1 whitespace-pre-wrap text-[14px] leading-6">{message.text}</p></div>) : run?.output ? <Markdown text={clampText(run.output, 10000)} /> : thread?.latestSummary ? <Markdown text={thread.latestSummary} /> : <p className="text-[14px] text-dim">No transcript messages available yet.</p>}
    </div>
    {run?.stderr ? <pre className="max-h-48 overflow-auto border-t border-line py-3 font-mono text-[12px] text-warn">{clampText(run.stderr, 3000)}</pre> : null}
    <div className="flex flex-wrap gap-2 border-t border-line pt-3">{sessionFile && onOpenSession ? <button onClick={() => void promote()} disabled={live} title={live ? "Stop or wait for the active turn first" : "Move this conversation into the main workspace"} className="context-button disabled:opacity-50">Open as session</button> : null}{controllable ? <><button onClick={() => void control("steer")} className="context-button is-primary">Steer</button><button onClick={() => void control("follow-up")} className="context-button">Follow up</button><button onClick={() => void control("stop")} className="context-button text-err">Stop</button></> : <span className="text-[13px] text-dim">This agent is read-only.</span>}</div>
  </div>;
}
function EmptyActivity({ icon, title, text }: { icon: string; title: string; text: string }) {
  return <div className="flex flex-col items-center gap-2 px-6 py-16 text-center"><span className="text-3xl text-dim">{icon}</span><p className="text-[14px] font-medium">{title}</p><p className="text-[14px] leading-relaxed text-dim">{text}</p></div>;
}

function HistoryTranscript({ history }: { history: WorkflowHistoryEntry[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {history.map((h, i) => {
        if (h.kind === "toolCall") {
          return (
            <div
              key={i}
              className="rounded-md border border-line/50 bg-inset/40 px-2.5 py-1.5 font-mono text-[14px] leading-relaxed text-fg/80"
            >
              <span className="font-semibold tracking-[0.02em] text-accent">tool · {h.toolName ?? "?"}</span>
              <span className="mt-0.5 block break-all whitespace-pre-wrap text-dim">{clampText(h.text, 500)}</span>
            </div>
          );
        }
        if (h.kind === "toolResult") {
          return (
            <div
              key={i}
              className={`rounded-md border px-2.5 py-1.5 font-mono text-[14px] leading-relaxed ${
                h.isError ? "border-err/25 bg-err/10 text-err/90" : "border-line/50 bg-bg/40 text-dim"
              }`}
            >
              {h.toolName ? <span className="font-semibold tracking-[0.02em]">{h.toolName}</span> : null}
              <span className="mt-0.5 block break-all whitespace-pre-wrap">{clampText(h.text, 500)}</span>
            </div>
          );
        }
        if (h.role === "user") {
          return (
            <div key={i} className="rounded-md bg-accent-soft/60 px-2.5 py-1.5 text-[14px] leading-relaxed text-fg/90">
              <span className="font-semibold text-accent">you</span>
              <span className="mt-0.5 block break-words whitespace-pre-wrap">{clampText(h.text, 800)}</span>
            </div>
          );
        }
        if (h.kind === "error") {
          return (
            <div key={i} className="rounded-md border border-err/25 bg-err/10 px-2.5 py-1.5 text-[14px] leading-relaxed text-err/90">
              {clampText(h.text, 800)}
            </div>
          );
        }
        return (
          <div key={i} className="rounded-md bg-bg/40 px-2.5 py-1.5 text-[14px] leading-relaxed text-fg/85">
            {clampText(h.text, 800)}
          </div>
        );
      })}
    </div>
  );
}
