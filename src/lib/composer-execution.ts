/**
 * Viewed-vs-execution composer access (execution/view split, I3/I4 UX).
 *
 * The selector is the truth layer ABOVE Commit 4's send-time arbitration:
 * it never locks anything backend-side — executionActivate still arbitrates
 * when the user actually sends. Three states, not a boolean:
 *
 *   owner     — viewed session IS the project's execution session: today's
 *               full composer (Stop, model, thinking, Goal/Design, stats).
 *   claimable — no owner, or the owner is idle/failed: typing + send are
 *               allowed (the next send transfers ownership via Commit 4);
 *               controls that mutate the OTHER runtime are not exposed.
 *   blocked   — a different owner is working/waiting/approval: composer
 *               reads history (draft preserved) with Return to live only.
 */
import { isExecutionBusyState, type ExecutionState, type ProjectExecution } from "../execution";

export type ComposerExecutionAccess =
  | { kind: "owner" }
  | { kind: "claimable" }
  | { kind: "blocked"; ownerSessionFile: string; ownerSessionId: string };

/** UI-facing projection of the access kind (labels + explicit navigation). */
export interface ComposerExecutionAccessUi {
  kind: "owner" | "claimable" | "blocked";
  /** Display name of the busy owner (blocked only). */
  ownerLabel?: string;
  /** State-specific busy phrasing (blocked only): "is working" / "is waiting" / "needs approval". */
  busyLabel?: string;
  /** Pure view navigation to the current owner — never activation. */
  onReturnToLive?(): void;
}

export function deriveComposerExecutionAccess(input: {
  viewedSessionPath: string | null;
  currentExecution: ProjectExecution | null;
  ownerExecutionState: ExecutionState | null;
}): ComposerExecutionAccess {
  const { viewedSessionPath, currentExecution } = input;
  if (!currentExecution) return { kind: "claimable" };
  if (viewedSessionPath != null && viewedSessionPath === currentExecution.sessionFile) return { kind: "owner" };
  // Live state first (runtimeByPath, event-derived); registry state as the
  // fallback so the lock clears the moment A transitions to idle.
  const state = input.ownerExecutionState ?? currentExecution.state;
  if (isExecutionBusyState(state)) {
    return { kind: "blocked", ownerSessionFile: currentExecution.sessionFile, ownerSessionId: currentExecution.sessionId };
  }
  return { kind: "claimable" };
}

/** Neutral-but-specific busy phrasing: approval must read as attention. */
export function executionBusyLabel(state: ExecutionState): string {
  if (state === "approval") return "needs approval";
  if (state === "waiting") return "is waiting";
  return "is working";
}

/**
 * ChatView/Composer streaming truth: only the VIEWED session's streaming
 * shows stream controls. A hidden execution session streaming never leaks
 * steer/queue/Stop/follow into another transcript (I3).
 */
export function deriveViewedStreaming(viewingExecution: boolean, activeStreaming: boolean): boolean {
  return viewingExecution && activeStreaming;
}

export interface ReturnToExecutionDeps {
  /** CURRENT owner from executionsByCwd — never a stored snapshot. */
  currentExecution: ProjectExecution | null | undefined;
  viewSession(path: string, cwd: string): unknown;
  /**
   * Test seam: the legacy activation surfaces a wrong implementation might
   * reach for. Production code must never call them from here (I3).
   */
  bridge?: {
    openSession?(...args: never[]): unknown;
    executionActivate?(...args: never[]): unknown;
    releaseSession?(...args: never[]): unknown;
  };
  onBeforeView?(): void;
}

/**
 * Return to live = pure view navigation to the CURRENT execution owner.
 * The owner already owns execution — this only changes what ChatView
 * displays. Never openSession/executionActivate/releaseSession (I3).
 * Returns false when the project has no owner (nothing to return to).
 */
export function returnToExecution(deps: ReturnToExecutionDeps): boolean {
  const execution = deps.currentExecution;
  if (!execution) return false;
  deps.onBeforeView?.();
  void deps.viewSession(execution.sessionFile, execution.cwd);
  return true;
}
