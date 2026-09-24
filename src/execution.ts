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

/*
 * Retention invariants (R1-R10) — the runtime-memory contract. They refine
 * I1/I2/I9 for the PiHost side: view = disk, execute = runtime, and there is
 * exactly ONE installed top-level AgentSession per normalized project cwd.
 *
 * R1. A normalized project cwd has at most one installed top-level SessionEntry.
 * R2. Every installed SessionEntry is the execution owner of its project.
 * R3. Every execution owner has exactly one installed SessionEntry.
 * R4. Historical/viewed/open-tab sessions do not require a SessionEntry.
 * R5. Creating or viewing a historical session cannot materialize a runtime.
 * R6. A busy execution owner is never released to make room for another session.
 * R7. Cross-project execution remains independent.
 * R8. Temporary Pi fork/switch construction may create a transient runtime,
 *     but no public operation may return while two installed entries remain
 *     for the same project.
 * R9. Runtime count scales with executing projects, not session count or tab count.
 * R10. ModelRuntime/project services are project resources and are not governed
 *      by the one-SessionEntry rule.
 */
export const RETENTION_INVARIANTS: readonly string[] = [
  "R1. A normalized project cwd has at most one installed top-level SessionEntry.",
  "R2. Every installed SessionEntry is the execution owner of its project.",
  "R3. Every execution owner has exactly one installed SessionEntry.",
  "R4. Historical/viewed/open-tab sessions do not require a SessionEntry.",
  "R5. Creating or viewing a historical session cannot materialize a runtime.",
  "R6. A busy execution owner is never released to make room for another session.",
  "R7. Cross-project execution remains independent.",
  "R8. Temporary Pi fork/switch construction may create a transient runtime, but no public operation may return while two installed entries remain for the same project.",
  "R9. Runtime count scales with executing projects, not session count or tab count.",
  "R10. ModelRuntime/project services are project resources and are not governed by the one-SessionEntry rule.",
];

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

// ── Wire results (IPC + daemon socket) ────────────────────────────────────
// Error classes do not survive message-only serializations, so activation
// reports busy as a structured envelope — same contract as GoalBeginResult.
// In-process callers still get the thrown ProjectExecutionBusyError from
// PiHost.activateExecution; local/daemon boundaries convert with
// toExecutionActivateResult.

export type ExecutionActivateResult =
  | { ok: true; execution: ProjectExecution }
  | { ok: false; code: "PROJECT_EXECUTION_BUSY"; busySessionFile: string; busySessionId: string };

function malformed(type: string): Error {
  return new Error(`${type} returned a malformed payload`);
}

function isExecutionState(v: unknown): v is ExecutionState {
  return v === "idle" || v === "working" || v === "waiting" || v === "approval" || v === "failed";
}

function isProjectExecution(v: unknown): v is ProjectExecution {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.cwd === "string" &&
    typeof r.sessionFile === "string" &&
    typeof r.sessionId === "string" &&
    isExecutionState(r.state) &&
    typeof r.streaming === "boolean" &&
    typeof r.generation === "number"
  );
}

/** Convert a caught activation error to the busy envelope, or null when the
 *  error is something else (rethrow it). */
export function toExecutionActivateResult(err: unknown): ExecutionActivateResult | null {
  if (!isProjectExecutionBusy(err)) return null;
  return { ok: false, code: "PROJECT_EXECUTION_BUSY", busySessionFile: err.busySessionFile, busySessionId: err.busySessionId };
}

/** Unwrap `{ executions: [...] }` from the wire; every entry must parse. */
export function unwrapExecutionListResult(payload: unknown, type: string): ProjectExecution[] {
  if (payload === null || typeof payload !== "object" || !("executions" in payload)) throw malformed(type);
  const list = (payload as { executions?: unknown }).executions;
  if (!Array.isArray(list) || !list.every(isProjectExecution)) throw malformed(type);
  return list;
}

/** Unwrap the activation envelope: ok must exist; busy carries all three
 *  identity keys; success carries a full execution record. */
export function unwrapExecutionActivateResult(payload: unknown, type: string): ExecutionActivateResult {
  if (payload === null || typeof payload !== "object") throw malformed(type);
  const r = payload as Record<string, unknown>;
  if (r.ok === true) {
    if (!isProjectExecution(r.execution)) throw malformed(type);
    return { ok: true, execution: r.execution };
  }
  if (r.ok === false) {
    if (r.code !== "PROJECT_EXECUTION_BUSY") throw malformed(type);
    if (typeof r.busySessionFile !== "string" || typeof r.busySessionId !== "string") throw malformed(type);
    return { ok: false, code: "PROJECT_EXECUTION_BUSY", busySessionFile: r.busySessionFile, busySessionId: r.busySessionId };
  }
  throw malformed(type);
}

/** Unwrap `{ released: boolean }` from the wire. */
export function unwrapExecutionDeactivateResult(payload: unknown, type: string): boolean {
  if (payload === null || typeof payload !== "object" || typeof (payload as { released?: unknown }).released !== "boolean") {
    throw malformed(type);
  }
  return (payload as { released: boolean }).released;
}
