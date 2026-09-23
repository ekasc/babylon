/**
 * Babylon execution vs. view model (see EXECUTION_INVARIANTS below).
 *
 * Terminology — these words have exactly one meaning everywhere:
 *
 *   viewedSession     conversation currently rendered in ChatView.
 *   executionSession  the one top-level Pi session allowed to execute for a
 *                     project (synonym in backend comments: executionOwner).
 *   openTab           a session in the horizontal tab bar. Does NOT imply a
 *                     live runtime.
 *   running           the execution session is currently doing work.
 *   coldSession       stored transcript with no Pi runtime.
 *
 * The invariant list lives in EXECUTION_INVARIANTS (comment + referenced by
 * electron/pi-host.invariants.test.ts). Renderer and backend both import
 * the types below; state is never inferred from "foreground", "active",
 * or whichever runtime happened to emit last.
 */

/** Lifecycle of a project's execution session. */
export type ExecutionState =
  | "idle"
  | "working"
  | "waiting"
  | "approval"
  | "failed";

/** One project's execution slot. The renderer keeps a Record<cwd, this>
 *  rebuilt from listProjectExecutions() + execution_changed events; the
 *  backend PiHost is the source of truth (executionByCwd). */
export interface ProjectExecution {
  cwd: string;
  sessionFile: string;
  sessionId: string;
  state: ExecutionState;
  streaming: boolean;
  /** Monotonic per-project activation counter: a stale settlement event
   *  (lower generation) can never overwrite newer ownership. */
  generation: number;
}

/** Typed rejection for activateExecution when the owner is busy. The busy
 *  owner's identity travels with the error so the renderer can point at it. */
export class ProjectExecutionBusyError extends Error {
  readonly code = "PROJECT_EXECUTION_BUSY";
  readonly busySessionFile: string;
  readonly busySessionId: string;
  constructor(busySessionFile: string, busySessionId: string) {
    super(`project execution busy: ${busySessionFile}`);
    this.name = "ProjectExecutionBusyError";
    this.busySessionFile = busySessionFile;
    this.busySessionId = busySessionId;
  }
}

export function isProjectExecutionBusy(err: unknown): err is ProjectExecutionBusyError {
  if (err instanceof ProjectExecutionBusyError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "PROJECT_EXECUTION_BUSY"
  );
}

/**
 * The ten invariants. Literally enforced by electron/pi-host.invariants.test.ts
 * (I1-I5, I7-I9 backend side) and src/execution.invariants.test.ts
 * (type-level / pure-model side); I6 and I10 are documented contracts of the
 * subagent parent relationship and Pi's active-session semantics.
 *
 * I1.  A Space may have at most one top-level execution session.
 * I2.  A session may be viewed without having a Pi runtime.
 * I3.  Viewing a session never changes execution ownership.
 * I4.  Sending from a session may acquire execution ownership only when the
 *      project's current owner is absent or idle.
 * I5.  UI tab lifecycle never controls execution lifetime.
 * I6.  Subagents/threads/workflows belong to the execution session that
 *      spawned them.
 * I7.  All mutating runtime operations have explicit session identity.
 * I8.  Foreground/view state is never an ownership fallback.
 * I9.  Historical session count does not determine runtime memory usage.
 * I10. Pi's active session, where Pi requires one, represents Babylon's
 *      execution session, never Babylon's viewed session.
 */
export const EXECUTION_INVARIANTS: readonly string[] = [
  "I1. A Space may have at most one top-level execution session.",
  "I2. A session may be viewed without having a Pi runtime.",
  "I3. Viewing a session never changes execution ownership.",
  "I4. Sending may acquire execution ownership only when the owner is absent or idle.",
  "I5. UI tab lifecycle never controls execution lifetime.",
  "I6. Subagents/threads/workflows belong to the execution session that spawned them.",
  "I7. All mutating runtime operations have explicit session identity.",
  "I8. Foreground/view state is never an ownership fallback.",
  "I9. Historical session count does not determine runtime memory usage.",
  "I10. Pi's active session represents Babylon's execution session, never the viewed session.",
];

/** Derive an ExecutionState from the flags the backend reports. Pure so the
 *  renderer and tests share one definition (approval dominates waiting,
 *  failed dominates idle — a failed owner is still the owner). */
export function deriveExecutionState(input: {
  streaming: boolean;
  approvalPending: boolean;
  waitingForInput: boolean;
  failed: boolean;
}): ExecutionState {
  if (input.approvalPending) return "approval";
  if (input.failed) return "failed";
  if (input.streaming) return "working";
  if (input.waitingForInput) return "waiting";
  return "idle";
}

/** True when the execution owner must not be transferred away (I4). Busy =
 *  working/waiting/approval — failed owners may be replaced. */
export function isExecutionBusyState(state: ExecutionState): boolean {
  return state === "working" || state === "waiting" || state === "approval";
}
