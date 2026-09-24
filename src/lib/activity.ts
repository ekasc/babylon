// Single definition of "running work" for every activity surface. The sidebar
// Agents section (running chats) is separate; this covers running subagents,
// persistent threads, and workflow runs.
import type { SubagentActivity, ThreadActivity, ThreadStatus, WorkflowRunSummary } from "../bridge";

const RUNNING_THREAD_STATUSES: readonly ThreadStatus[] = ["queued", "starting", "running", "interrupting"];

export function isRunningThread(status: ThreadStatus): boolean {
  return RUNNING_THREAD_STATUSES.includes(status);
}

export function isRunningSubagent(status: SubagentActivity["status"]): boolean {
  return status === "starting" || status === "running";
}

export function isActiveWorkflow(status: WorkflowRunSummary["status"]): boolean {
  return status === "pending" || status === "running" || status === "paused";
}

/** Project cwd of a thread: its own, else the session that owns it. */
export function threadCwd(
  thread: Pick<ThreadActivity, "cwd" | "sessionFile" | "parentSessionFile">,
  resolveCwd?: (file: string | null | undefined) => string | null
): string | null {
  return thread.cwd ?? resolveCwd?.(thread.parentSessionFile ?? thread.sessionFile) ?? null;
}

export function subagentCwd(
  subagent: Pick<SubagentActivity, "sessionFile" | "parentSessionFile">,
  resolveCwd?: (file: string | null | undefined) => string | null
): string | null {
  return resolveCwd?.(subagent.parentSessionFile ?? subagent.sessionFile) ?? null;
}

export function workflowCwd(
  run: Pick<WorkflowRunSummary, "sessionId">,
  resolveRunCwd?: (sessionId: string | null | undefined) => string | null
): string | null {
  return resolveRunCwd?.(run.sessionId) ?? null;
}

/** Unattributed items stay visible: live work must never vanish because its
 *  project could not be resolved. */
export function inScope(cwd: string | null, scope: string | null | undefined): boolean {
  if (!scope) return true;
  return cwd == null || cwd === scope;
}

export interface RunningWorkInput {
  threads: ThreadActivity[];
  subagents: SubagentActivity[];
  workflows: WorkflowRunSummary[];
  scope?: string | null;
  resolveCwd?: (file: string | null | undefined) => string | null;
  resolveRunCwd?: (sessionId: string | null | undefined) => string | null;
}

/** Count of running subagents + threads + workflows, scoped to a project. */
export function countRunningWork(input: RunningWorkInput): number {
  let n = 0;
  for (const t of input.threads) {
    if (isRunningThread(t.status) && inScope(threadCwd(t, input.resolveCwd), input.scope)) n++;
  }
  for (const s of input.subagents) {
    if (isRunningSubagent(s.status) && inScope(subagentCwd(s, input.resolveCwd), input.scope)) n++;
  }
  for (const r of input.workflows) {
    if (isActiveWorkflow(r.status) && inScope(workflowCwd(r, input.resolveRunCwd), input.scope)) n++;
  }
  return n;
}
