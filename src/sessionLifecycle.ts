export interface SessionEventContext {
  /** The conversation whose transcript is on screen. */
  viewedSessionPath: string | null;
  /** True while a VIEW switch is still in flight. */
  switching: boolean;
}

/**
 * Transcript acceptance, by PATH. The caller has already resolved the event's
 * own identity (its `sessionFile`, or its `sessionId` through the session
 * index); an event may enter the viewed transcript only when that path IS the
 * viewed one and no view switch is in flight. An event whose path could not be
 * resolved is dropped rather than guessed at.
 */
export function shouldAcceptEvent(eventPath: string | null, context: SessionEventContext): boolean {
  if (context.switching) return false;
  if (context.viewedSessionPath === null) return false;
  return eventPath != null && eventPath === context.viewedSessionPath;
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
