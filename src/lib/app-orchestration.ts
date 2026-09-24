/**
 * The three App-level policies that C11 makes structural, extracted as pure
 * functions so they can be tested without mounting the whole renderer:
 *
 *   1. runtime health      — shell state with no session/project identity (C4)
 *   2. project settings    — follow the UI's active project, never a runtime (C2)
 *   3. group open / reconnect — claim once, and restore EVERY project owner
 *
 * Each function returns what to do. None of them can navigate, activate, or
 * prune ownership: that is the point of extracting them.
 */
import type { RuntimeStatus } from "../bridge";
import type { ProjectExecution } from "../execution";

/** What a runtime-health update means for the shell. There is deliberately no
 *  session, cwd, or navigation field here to fill in. */
export interface RuntimeStatusOutcome {
  status: RuntimeStatus;
  /** Fatal startup error worth surfacing, if any. */
  errorMessage: string | null;
}

export function applyRuntimeStatus(_previous: RuntimeStatus, next: RuntimeStatus): RuntimeStatusOutcome {
  // Rebuild the health value field by field. Anything else that rode along —
  // a session file, a cwd, a request id — is dropped here, so it can never
  // reach renderer state and become a selection authority.
  const status: RuntimeStatus =
    next.status === "error" && next.message !== undefined
      ? { status: "error", message: next.message }
      : { status: next.status };
  return { status, errorMessage: status.status === "error" ? status.message ?? null : null };
}

/** The project whose settings the UI shows: the active project, full stop. */
export function projectSettingsCwd(activeSpace: string | null): string | null {
  return activeSpace;
}

/** Project context for opening a group room, in authority order. Returns null
 *  when the user must pick a folder. */
export function groupChatCwd(input: {
  groupCwd?: string;
  memberCwd?: string;
  projectFilter: string;
  activeSpace: string | null;
}): string | null {
  return (
    input.groupCwd ??
    input.memberCwd ??
    (input.projectFilter !== "all" ? input.projectFilter : null) ??
    input.activeSpace ??
    null
  );
}

/**
 * Reconnect outcome. Every project owner the registry reports is kept — a
 * background Space may still be executing — and the viewed path is rehydrated
 * only when it really is one of those owners.
 */
export interface ReconnectOutcome {
  /** Event-derived path state starts empty; owner state comes from the registry. */
  clearEventState: true;
  rehydratePath: string | null;
}

export function reconnectExecutions(
  owners: readonly ProjectExecution[],
  viewedSessionPath: string | null
): ReconnectOutcome {
  const owned = new Set(owners.map((owner) => owner.sessionFile));
  return {
    clearEventState: true,
    rehydratePath: viewedSessionPath && owned.has(viewedSessionPath) ? viewedSessionPath : null,
  };
}
