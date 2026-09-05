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

export interface AgentLiveness {
  /** Transcript-level streaming (set by agent_start, cleared by agent_settled). */
  streaming: boolean;
  /** Last hydrated host truth, survives renderer reloads that wipe the transcript state. */
  hostStreaming?: boolean;
  liveActivityCount?: number;
  runningWorkflows?: number;
}

/**
 * Single rule for "is the agent busy?" Every running indicator (header dot,
 * sidebar presence, composer busy state) reads this, so a reload mid-turn ,
 * which resets the transcript's streaming flag, still shows state via the
 * host truth captured by the last hydrate.
 */
export function isAgentLive(input: AgentLiveness): boolean {
  return (
    input.streaming ||
    input.hostStreaming === true ||
    (input.liveActivityCount ?? 0) > 0 ||
    (input.runningWorkflows ?? 0) > 0
  );
}
