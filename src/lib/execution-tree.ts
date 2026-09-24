/**
 * Agents dock = project execution trees (execution/view split).
 *
 * ONE root per project, created exclusively from `executionsByCwd`
 * (ProjectExecution is the ownership authority). Activity sources —
 * subagents, threads, workflows — may only contribute CHILDREN under an
 * existing root, matched by parent identity (session id, else session
 * file) — never by cwd, and never by manufacturing a root of their own.
 * `runtimeByPath` enriches an already-known owner's live state and
 * attention; it never establishes ownership (I1/I6).
 *
 * A quiet owner alone does not appear: Agents is the live execution
 * monitor, not retained sessions (the Sessions shelves own that) and not
 * an inbox (attention surfaces own failures).
 */
import type { SubagentActivity, ThreadActivity, ThreadStatus, WorkflowRunSummary } from "../bridge";
import type { AttentionState, ExecutionState, SessionRuntimeState } from "../sessionRuntime";
import type { ProjectExecution } from "../execution";

export type ExecutionChildKind = "subagent" | "thread" | "workflow";

export interface ExecutionChildNode {
  key: string;
  kind: ExecutionChildKind;
  label: string;
  statusLabel: string;
  /** Presentation state: `waiting` means "still prevents execution transfer". */
  state: "working" | "waiting";
  sessionFile?: string | null;
  parentSessionFile?: string | null;
  parentSessionId?: string | null;
  startedAt?: number;
}

export interface ExecutionTree {
  cwd: string;
  sessionFile: string;
  sessionId: string;
  title: string;
  projectName: string;
  state: "working" | "waiting" | "approval";
  attention: AttentionState;
  children: ExecutionChildNode[];
}

// ── Execution-holding predicates (explicit names: ownership ≠ CPU activity) ──

/** Active subagents are exactly ManagedSubagents.hasActiveForSession(). */
export function subagentHoldsExecution(status: SubagentActivity["status"]): boolean {
  return status === "starting" || status === "running";
}

/** Mirrors PiHost.hasActiveThreadsForSession(): everything except the
 *  terminal trio still causes PROJECT_EXECUTION_BUSY — Agents must never
 *  show Idle while an invisible blocked/idle/interrupted thread owns the
 *  project. Intentionally NOT runtime's narrower isRunningThread(). */
export function threadHoldsExecution(status: ThreadStatus): boolean {
  return status !== "completed" && status !== "failed" && status !== "stopped";
}

export function workflowHoldsExecution(status: WorkflowRunSummary["status"]): boolean {
  return status === "pending" || status === "running" || status === "paused";
}

/** Parent identity: session id when present, else session file. Cwd is
 *  NEVER parent identity — two histories share a project (I6). */
function ownsChild(
  root: { sessionId: string; sessionFile: string },
  child: { parentSessionId?: string | null; parentSessionFile?: string | null }
): boolean {
  if (child.parentSessionId) return child.parentSessionId === root.sessionId;
  if (child.parentSessionFile) return child.parentSessionFile === root.sessionFile;
  return false;
}

function threadChild(t: ThreadActivity): ExecutionChildNode | null {
  if (!threadHoldsExecution(t.status)) return null;
  const label = (t.name ?? "").trim() || t.goal.trim() || t.threadId.slice(0, 8);
  let state: ExecutionChildNode["state"];
  let statusLabel: string;
  switch (t.status) {
    case "queued":
      state = "working";
      statusLabel = "Queued";
      break;
    case "starting":
      state = "working";
      statusLabel = "Starting";
      break;
    case "running":
      state = "working";
      statusLabel = "Running";
      break;
    case "interrupting":
      state = "working";
      statusLabel = "Stopping";
      break;
    case "blocked":
      state = "waiting";
      statusLabel = "Blocked";
      break;
    case "idle":
      state = "waiting";
      statusLabel = "Idle";
      break;
    case "interrupted":
      state = "waiting";
      statusLabel = "Interrupted";
      break;
    default:
      return null;
  }
  const parsed = Date.parse(t.createdAt);
  return {
    key: `thread:${t.threadId}`,
    kind: "thread",
    label,
    statusLabel,
    state,
    sessionFile: t.sessionFile,
    parentSessionFile: t.parentSessionFile ?? null,
    parentSessionId: t.parentSessionId,
    startedAt: Number.isFinite(parsed) ? parsed : undefined,
  };
}

function subagentChild(s: SubagentActivity): ExecutionChildNode | null {
  if (!subagentHoldsExecution(s.status)) return null;
  const label = (s.name ?? "").trim() || (s.task ?? "").trim() || (s.profile ?? "").trim() || s.runId.slice(0, 8);
  const parsed = s.startedAt ? Date.parse(s.startedAt) : Number.NaN;
  return {
    key: `subagent:${s.runId}`,
    kind: "subagent",
    label,
    statusLabel: s.status === "starting" ? "Starting" : "Running",
    state: "working",
    sessionFile: s.sessionFile ?? null,
    parentSessionFile: s.parentSessionFile ?? null,
    parentSessionId: s.parentSessionId ?? null,
    startedAt: Number.isFinite(parsed) ? parsed : undefined,
  };
}

function workflowChild(r: WorkflowRunSummary): ExecutionChildNode | null {
  if (!workflowHoldsExecution(r.status)) return null;
  if (!r.sessionId) return null; // legacy/global run: no owner, no attachment (I6)
  const label = r.workflowName.trim() || r.runId.slice(0, 8);
  const parsed = r.startedAt ? Date.parse(r.startedAt) : Number.NaN;
  return {
    key: `workflow:${r.runId}`,
    kind: "workflow",
    label,
    statusLabel: r.status === "paused" ? "Paused" : r.status === "pending" ? "Pending" : "Running",
    state: r.status === "paused" ? "waiting" : "working",
    parentSessionId: r.sessionId,
    startedAt: Number.isFinite(parsed) ? parsed : undefined,
  };
}

/** Child order (spec): blocked/paused first, then running, starting/queued,
 *  interrupting, idle/interrupted — rows must not jump between refreshes. */
const CHILD_ORDER = ["Blocked", "Paused", "Running", "Starting", "Queued", "Stopping", "Idle", "Interrupted"];

function childRank(c: ExecutionChildNode): number {
  const i = CHILD_ORDER.indexOf(c.statusLabel);
  return i === -1 ? 99 : i;
}

/**
 * Aggregate display state for a root. Waiting outranks working because it
 * is actionable; approval (main only) outranks everything. `null` = the
 * tree is quiet and must not render (idle/failed owner with no active
 * children).
 */
export function aggregateTreeState(
  main: ExecutionState,
  children: ExecutionChildNode[]
): "working" | "waiting" | "approval" | null {
  if (main === "approval") return "approval";
  if (main === "waiting" || children.some((c) => c.state === "waiting")) return "waiting";
  if (main === "working" || children.some((c) => c.state === "working")) return "working";
  return null;
}

export interface DeriveExecutionTreesInput {
  /** Object.values(executionsByCwd) — the ONLY root source. */
  executions: readonly ProjectExecution[];
  /** Enrichment only: live state + attention for an already-owned session. */
  runtimeByPath: Record<string, SessionRuntimeState>;
  threads: readonly ThreadActivity[];
  subagents: readonly SubagentActivity[];
  workflows: readonly WorkflowRunSummary[];
  titleFor(sessionFile: string): string;
  /** Current Space: sorts its root first within equal urgency. */
  activeCwd?: string | null;
}

export function deriveExecutionTrees(input: DeriveExecutionTreesInput): ExecutionTree[] {
  const trees: ExecutionTree[] = [];
  const seenCwds = new Set<string>();
  for (const execution of input.executions) {
    // One root per project, even if a mis-built input repeats a cwd (I1).
    if (seenCwds.has(execution.cwd)) continue;
    seenCwds.add(execution.cwd);
    const live = input.runtimeByPath[execution.sessionFile];
    const mainState: ExecutionState = live?.execution ?? execution.state;
    const children: ExecutionChildNode[] = [];
    for (const s of input.subagents) {
      if (!subagentHoldsExecution(s.status)) continue;
      if (!ownsChild(execution, s)) continue;
      const child = subagentChild(s);
      if (child) children.push(child);
    }
    for (const t of input.threads) {
      if (!threadHoldsExecution(t.status)) continue;
      if (!ownsChild(execution, t)) continue;
      const child = threadChild(t);
      if (child) children.push(child);
    }
    for (const r of input.workflows) {
      if (!r.sessionId || r.sessionId !== execution.sessionId) continue;
      if (!workflowHoldsExecution(r.status)) continue;
      const child = workflowChild(r);
      if (child) children.push(child);
    }
    children.sort(
      (a, b) => childRank(a) - childRank(b) || a.label.localeCompare(b.label) || (a.startedAt ?? 0) - (b.startedAt ?? 0)
    );
    const state = aggregateTreeState(mainState, children);
    if (!state) continue; // quiet owner (incl. failed-with-no-children) is not an Agent
    trees.push({
      cwd: execution.cwd,
      sessionFile: execution.sessionFile,
      sessionId: execution.sessionId,
      title: input.titleFor(execution.sessionFile),
      projectName: execution.cwd.split("/").filter(Boolean).pop() || execution.cwd,
      state,
      attention: live?.attention ?? "none",
      children,
    });
  }
  const urgency = (s: ExecutionTree["state"]) => (s === "approval" ? 0 : s === "waiting" ? 1 : 2);
  const activeCwd = input.activeCwd ?? null;
  trees.sort(
    (a, b) =>
      urgency(a.state) - urgency(b.state) ||
      (activeCwd ? Number(b.cwd === activeCwd) - Number(a.cwd === activeCwd) : 0) ||
      a.projectName.localeCompare(b.projectName) ||
      a.title.localeCompare(b.title)
  );
  return trees;
}

/** Root click = view the owning session only. No activation, ever (I3):
 *  the root already owns execution. Seams exist so the invariant is
 *  testable (mutation: reaching for executionActivate/openSession). */
export function openExecutionRoot(
  deps: {
    viewSession(sessionFile: string, cwd: string): unknown;
    onBeforeView?(): void;
    bridge?: {
      openSession?(...args: never[]): unknown;
      executionActivate?(...args: never[]): unknown;
      releaseSession?(...args: never[]): unknown;
    };
  },
  tree: Pick<ExecutionTree, "sessionFile" | "cwd">
): void {
  deps.onBeforeView?.();
  void deps.viewSession(tree.sessionFile, tree.cwd);
}
