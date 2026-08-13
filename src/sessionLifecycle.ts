export interface SessionEventContext {
  /** The live pi session currently bound to the transcript. */
  activeSessionId: string | null;
  /** True while a session replacement is still in flight. */
  switching: boolean;
}

/**
 * Agent events are session-local. During a switch, or when an event belongs to
 * another session, accepting it would leak stale TUI/GUI output into the open
 * transcript.
 */
export function shouldAcceptEvent(event: any, context: SessionEventContext): boolean {
  if (!event || typeof event !== "object") return false;
  if (context.switching) return false;
  if (typeof event.sessionId !== "string") return true;
  return context.activeSessionId !== null && event.sessionId === context.activeSessionId;
}
