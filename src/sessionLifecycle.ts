export interface SessionEventContext {
  /** The session whose transcript is on screen. */
  viewedSessionId: string | null;
  /** True while a VIEW switch is still in flight. */
  switching: boolean;
}

/**
 * Agent events are session-local. An event may enter the viewed transcript
 * only when it belongs to the viewed session and no view switch is in flight:
 * an event from a background owner updates ITS bookkeeping (handled
 * separately) and never the conversation on screen.
 */
import type { AgentEvent } from "./bridge";

export function shouldAcceptEvent(event: AgentEvent, context: SessionEventContext): boolean {
  if (!event || typeof event !== "object") return false;
  if (context.switching) return false;
  if (typeof event.sessionId !== "string") return false;
  return context.viewedSessionId !== null && event.sessionId === context.viewedSessionId;
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
