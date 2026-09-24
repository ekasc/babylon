// Canonical session/runtime state for Slice 2.
//
// Three separate dimensions — lifecycle, execution, attention — derived once
// in App and consumed by the sidebar, Space activity, header, and Agents
// dock.
//
// SessionRuntimeState is a RENDERER PROJECTION of observed per-session
// activity (events, file-backed rosters, snapshots) — not an ownership
// registry. Top-level execution ownership is authoritative in
// ProjectExecution / executionsByCwd: runtimeByPath may enrich an owner's
// live state and attention but never establishes ownership, never creates
// an Agents root, and never decides which tab is executing. The per-path
// map stays keyed by path (never by foreground) so concurrent sources and
// rapid navigation cannot corrupt each other.
//
// Execution vocabulary (smallest truthful set for Pi's event model):
//   idle     — nothing running
//   working  — an agent turn is executing (agent_start … agent_settled)
//   waiting  — paused, needs user input to continue (paused workflow)
//   approval — blocked on an approval/permission decision right now
//   failed   — interrupted or errored work asking for attention
//
// Display priority (single badge per row): approval, working, failed,
// waiting, unread completion, idle age.

import { listAttention, type AttentionRegistry } from "./attention";
import { type Bot } from "./bots";
import type { ProjectExecution } from "./execution";
import type { SubagentActivity, ThreadActivity, ThreadStatus, WorkflowRunSummary } from "./bridge";

export type SessionLifecycle = "open" | "settled";

export type ExecutionState = "idle" | "working" | "waiting" | "approval" | "failed";

export type AttentionState = "none" | "unread" | "approval";

export interface SessionRuntimeState {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  lifecycle: SessionLifecycle;
  execution: ExecutionState;
  attention: AttentionState;
  live: boolean;
  startedAt?: number;
  botId?: string;
}

export function isLiveExecution(execution: ExecutionState): boolean {
  return execution !== "idle";
}

/** Display priority: higher rank wins the single row badge. Anything awaiting
 *  the user outranks ambient activity; live work outranks terminal failure. */
const EXECUTION_RANK: Record<ExecutionState, number> = {
  idle: 0,
  failed: 1,
  working: 2,
  waiting: 3,
  approval: 4,
};

/**
 * Merge file-backed/remote source snapshots (threads, subagents, workflows)
 * into per-path execution. Sources only ESCALATE toward live states: an
 * absent or terminal source never clears an entry — clearing belongs to the
 * ordered event layer (agent_settled), so navigation and snapshot refreshes
 * can neither resurrect nor kill activity.
 */
export interface SourceSnapshots {
  threads: Array<Pick<ThreadActivity, "status" | "sessionFile" | "parentSessionFile">>;
  subagents: Array<Pick<SubagentActivity, "status" | "sessionFile" | "parentSessionFile">>;
  workflows: Array<Pick<WorkflowRunSummary, "status" | "sessionId">>;
}

/** One work item with the fields failure/unread tracking reads. Shared with
 *  App's failure watcher so the two can't drift apart. */
export interface WorkSourceItem {
  status: string;
  sessionFile?: string | null;
  parentSessionFile?: string | null;
}

const THREAD_LIVE = new Set(["queued", "starting", "running", "interrupting"]);

function threadExecution(status: ThreadStatus): ExecutionState {
  if (THREAD_LIVE.has(status)) return "working";
  if (status === "interrupted" || status === "failed") return "failed";
  return "idle";
}

function subagentExecution(status: SubagentActivity["status"]): ExecutionState {
  if (status === "running" || status === "starting") return "working";
  if (status === "interrupted" || status === "failed") return "failed";
  return "idle";
}

function workflowExecution(status: WorkflowRunSummary["status"]): ExecutionState {
  if (status === "pending" || status === "running") return "working";
  if (status === "paused") return "waiting";
  return "idle";
}

export function mergeSourceExecutions(
  base: Record<string, ExecutionState>,
  sources: SourceSnapshots,
  resolveWorkflowPath: (sessionId?: string) => string | undefined
): Record<string, ExecutionState> {
  let out = base;
  const mark = (path: string | null | undefined, execution: ExecutionState) => {
    if (!path || execution === "idle") return;
    const merged = strongerExecution(out[path] ?? "idle", execution);
    if (merged !== out[path]) out = { ...out, [path]: merged };
  };
  for (const t of sources.threads) {
    const exec = threadExecution(t.status);
    mark(t.sessionFile, exec);
    mark(t.parentSessionFile, exec);
  }
  for (const s of sources.subagents) {
    const exec = subagentExecution(s.status);
    mark(s.sessionFile, exec);
    mark(s.parentSessionFile, exec);
  }
  for (const r of sources.workflows) {
    mark(r.sessionId ? resolveWorkflowPath(r.sessionId) : undefined, workflowExecution(r.status));
  }
  return out;
}

/** Merge competing liveness sources for one session (event layer, thread
 *  snapshots, workflow snapshots, active transcript). The strongest
 *  non-idle state wins so a working thread is never masked by an idle feed. */
export function strongerExecution(a: ExecutionState, b: ExecutionState): ExecutionState {
  return EXECUTION_RANK[a] >= EXECUTION_RANK[b] ? a : b;
}

export function deriveAttention(args: { approval: boolean; unread: boolean }): AttentionState {
  if (args.approval) return "approval";
  if (args.unread) return "unread";
  return "none";
}

/**
 * Single visual/state priority for attention (Slice 5): actionable
 * (approval or waiting input) outranks unread completion, which outranks
 * nothing. Sessions, Space headers, and dots all read this one order.
 */
const ATTENTION_RANK: Record<AttentionState, number> = {
  none: 0,
  unread: 1,
  approval: 2,
};

export function maxAttention(a: AttentionState, b: AttentionState): AttentionState {
  return ATTENTION_RANK[a] >= ATTENTION_RANK[b] ? a : b;
}

export function deriveSpaceAttention(children: AttentionState[]): AttentionState {
  let top: AttentionState = "none";
  for (const c of children) top = maxAttention(top, c);
  return top;
}

/** The one dot a compact row may show: approval > failed > unread > live. */
export function statusDotKind(
  execution: ExecutionState,
  unread: boolean
): "approval" | "failed" | "unread" | "live" | null {
  if (execution === "approval" || execution === "waiting") return "approval";
  if (execution === "failed") return "failed";
  if (unread) return "unread";
  if (isLiveExecution(execution)) return "live";
  return null;
}

export function assembleRuntimeState(args: {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  lifecycle: SessionLifecycle;
  execution: ExecutionState;
  attention: AttentionState;
  startedAt?: number;
  botId?: string;
}): SessionRuntimeState {
  return {
    sessionId: args.sessionId,
    sessionPath: args.sessionPath,
    cwd: args.cwd,
    lifecycle: args.lifecycle,
    execution: args.execution,
    attention: args.attention,
    live: isLiveExecution(args.execution),
    ...(args.startedAt != null ? { startedAt: args.startedAt } : {}),
    ...(args.botId ? { botId: args.botId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Event-driven execution layer (one entry per session path).
//
// Agent events arrive on one ordered IPC channel for every session, not just
// the open one, so background runs are tracked under their own path and
// switching sessions never redefines what is alive. Each entry carries the
// sequence number of the last applied event; older sequences are stale
// (duplicate/redelivered) and ignored, so late events cannot resurrect
// cleared activity.
// ---------------------------------------------------------------------------

export interface PathExecution {
  execution: ExecutionState;
  startedAt: number | null;
  seq: number;
}

export type PathExecutionMap = Record<string, PathExecution>;

export function emptyExecutions(): PathExecutionMap {
  return {};
}

export interface RuntimeEventContext {
  /** Session path the event belongs to, or null when unresolvable (ignored). */
  path: string | null;
  /** Monotonic sequence from the receiver; older-or-equal is stale. */
  seq: number;
  now: number;
}

function setExec(
  prev: PathExecutionMap,
  path: string,
  execution: ExecutionState,
  seq: number,
  now: number
): PathExecutionMap {
  const cur = prev[path];
  if (cur && seq <= cur.seq) return prev;
  const wasLive = cur ? isLiveExecution(cur.execution) : false;
  const next: PathExecution = {
    execution,
    startedAt: isLiveExecution(execution) ? (wasLive && cur ? cur.startedAt : now) : null,
    seq,
  };
  if (cur && cur.execution === next.execution && cur.startedAt === next.startedAt) return prev;
  return { ...prev, [path]: next };
}

export function applyRuntimeEvent(
  prev: PathExecutionMap,
  event: { type?: string } | null | undefined,
  ctx: RuntimeEventContext
): PathExecutionMap {
  if (!event || typeof event !== "object" || !ctx.path) return prev;
  switch (event.type) {
    case "agent_start":
      return setExec(prev, ctx.path, "working", ctx.seq, ctx.now);
    case "agent_settled":
    case "agent_end":
      // Abort lands here too (settled with aborted flag): clearing is
      // correct, and the immediate next run re-marks the same path entry,
      // so exactly one live entry exists at any time.
      return setExec(prev, ctx.path, "idle", ctx.seq, ctx.now);
    case "extension_ui_request":
      return setExec(prev, ctx.path, "approval", ctx.seq, ctx.now);
    case "extension_ui_response":
    case "extension_ui_cancel": {
      // The dialog closed (answered, dismissed, timed out, or aborted): release
      // the approval gate so the entry returns to the live run. Only a gate we
      // actually set is released; anything else must not resurrect activity.
      const cur = prev[ctx.path];
      if (!cur || cur.execution !== "approval" || ctx.seq <= cur.seq) return prev;
      return setExec(prev, ctx.path, "working", ctx.seq, ctx.now);
    }
    default:
      return prev;
  }
}

/** Approval resolution arrives over IPC (not as an agent event): the run it
 *  gated resumes, so an approval entry returns to working. */
export function resolveApprovalExecution(
  prev: PathExecutionMap,
  path: string,
  seq: number,
  now: number
): PathExecutionMap {
  const cur = prev[path];
  if (!cur || cur.execution !== "approval") return prev;
  return setExec(prev, path, "working", seq, now);
}

/** Path an approval resolution targets: the request's OWN session identity
 *  only. A payload with no (or an unknown) session resolves to null, so it can
 *  never mutate whatever the user happens to be viewing (C3). */
export function resolveApprovalPath(
  sessionId: string | null | undefined,
  idToPath: Map<string, string> | Record<string, string>
): string | null {
  if (!sessionId) return null;
  return idToPath instanceof Map ? idToPath.get(sessionId) ?? null : idToPath[sessionId] ?? null;
}

// ---------------------------------------------------------------------------
// Settlement: explicit, persisted, never inferred.
// ---------------------------------------------------------------------------

/** Live work blocks settlement: working, waiting for input, or approval. A
 *  failed run is over, so it may settle. */
export function canSettle(execution: ExecutionState): boolean {
  return execution === "idle" || execution === "failed";
}

/** Newest-settled first; ties broken by path for a stable order. */
export function compareSettled(a: { path: string; at: number }, b: { path: string; at: number }): number {
  if (b.at !== a.at) return b.at - a.at;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Compact run duration for the isolated sidebar timer ("32s", "4m", "1h2m"). */
export function formatRunDuration(elapsedMs: number): string {
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}

/**
 * Resolve an agent event to the session path it describes, by its OWN
 * identity: the id map, or nothing. There is no active/viewed/foreground
 * fallback, so an unstamped event can never mutate a random conversation.
 */
export function resolveRuntimePath(
  sessionId: string | null | undefined,
  idToPath: Map<string, string> | Record<string, string>,
  requireKnown = false
): string | null {
  if (!sessionId) return null;
  const p = idToPath instanceof Map ? idToPath.get(sessionId) : idToPath[sessionId];
  if (p) return p;
  return requireKnown ? null : null;
}

// ---------------------------------------------------------------------------
// Composition: assemble the per-path runtime map from every liveness input.
// Pure, so it is testable without React; App only memoizes the call.
// ---------------------------------------------------------------------------

export interface RuntimeByPathInput {
  groups: Array<{ sessions: Array<{ id: string; path: string; cwd: string }> }>;
  executions: PathExecutionMap;
  settled: Record<string, number>;
  unread: string[];
  attention: AttentionRegistry;
  activity: { threads: SourceSnapshots["threads"]; subagents: SourceSnapshots["subagents"] };
  workflowRuns: SourceSnapshots["workflows"];
  viewedSessionPath: string | null;
  /** Project cwd of the viewed conversation (session metadata, then activeSpace). */
  viewedCwd: string | null;
  /** Authoritative project execution owners: who actually runs, per project. */
  projectExecutions: readonly ProjectExecution[];
  bots: Array<Pick<Bot, "id" | "mainSessionFile"> & { sessionsByProject?: Record<string, string> }>;
}

export function computeRuntimeByPath(input: RuntimeByPathInput): Record<string, SessionRuntimeState> {
  const {
    groups,
    executions,
    settled,
    unread,
    attention,
    activity,
    workflowRuns,
    viewedSessionPath,
    viewedCwd,
    projectExecutions,
    bots,
  } = input;

  const map: Record<string, SessionRuntimeState> = {};
  const sessionIdToPath = new Map<string, string>();
  const ensure = (sessionId: string, sessionPath: string, cwd: string) =>
    (map[sessionPath] ??= assembleRuntimeState({
      sessionId,
      sessionPath,
      cwd,
      lifecycle: settled[sessionPath] != null ? "settled" : "open",
      execution: "idle",
      attention: "none",
    }));
  for (const g of groups) for (const s of g.sessions) {
    sessionIdToPath.set(s.id, s.path);
    ensure(s.id, s.path, s.cwd);
  }
  // Execution registry CREATES and enriches owner rows: a fresh, unflushed
  // owner must appear even before the disk index knows it (items 82, 170).
  for (const execution of projectExecutions) {
    ensure(execution.sessionId, execution.sessionFile, execution.cwd);
    const row = map[execution.sessionFile];
    if (row) row.execution = strongerExecution(row.execution, execution.state);
  }
  // A viewed conversation the index has not caught up with yet still gets a
  // row — from the viewed path and ITS OWN cwd, never a global status cwd.
  if (viewedSessionPath && !map[viewedSessionPath]) {
    ensure(viewedSessionPath, viewedSessionPath, viewedCwd ?? "");
  }
  // Event layer (all sessions, survives navigation).
  for (const [path, rec] of Object.entries(executions)) {
    const e = map[path];
    if (!e) continue;
    e.execution = strongerExecution(e.execution, rec.execution);
  }
  // Thread/subagent/workflow snapshots escalate per-path execution through one
  // pure merge (keyed by owning session path, never by foreground state).
  const sourceExec = mergeSourceExecutions(
    {},
    { threads: activity.threads, subagents: activity.subagents, workflows: workflowRuns },
    (sid) => (sid ? sessionIdToPath.get(sid) : undefined)
  );
  for (const [path, exec] of Object.entries(sourceExec)) {
    const e = map[path];
    if (e) e.execution = strongerExecution(e.execution, exec);
  }
  const openAttention = listAttention(attention);
  const unreadSet = new Set(unread);
  // Bot attribution by session path, resolved once (was O(sessions x bots)).
  const botBySessionPath = new Map<string, string>();
  for (const b of bots) {
    const paths = new Set<string>();
    if (b.sessionsByProject) for (const p of Object.values(b.sessionsByProject)) paths.add(p);
    if (b.mainSessionFile) paths.add(b.mainSessionFile);
    for (const p of paths) if (!botBySessionPath.has(p)) botBySessionPath.set(p, b.id);
  }
  for (const e of Object.values(map)) {
    // Started-at rides along only when known (event layer).
    if (e.execution !== "idle" && e.startedAt == null) {
      const rec = executions[e.sessionPath];
      if (rec?.startedAt != null) e.startedAt = rec.startedAt;
    }
    const approvalOpen =
      e.execution === "approval" ||
      e.execution === "waiting" ||
      openAttention.some(
        (a) => (a.type === "permission" || a.type === "question") && a.source === e.sessionPath
      );
    e.attention = deriveAttention({ approval: approvalOpen, unread: unreadSet.has(e.sessionPath) });
    e.live = isLiveExecution(e.execution);
    const botId = botBySessionPath.get(e.sessionPath);
    if (botId) e.botId = botId;
  }
  return map;
}
