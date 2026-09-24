/**
 * Runtime event planning (C3/C7).
 *
 * The renderer receives events for EVERY executing project. This module turns
 * one batch into an explicit plan, so the App's job is only to apply it:
 *
 *   - transcript dispatch  → the VIEWED conversation's own events only
 *   - execution bookkeeping → ALWAYS, including with nothing on screen
 *   - view side effects (state refresh, resync) → the viewed conversation only
 *
 * Because the plan is computed from the event's own identity, no caller can
 * accidentally gate background work on "is anything on screen?".
 */
import type { AgentEvent } from "../bridge";
import { shouldAcceptEvent } from "../sessionLifecycle";

export interface RuntimeEventContext {
  /** The conversation on screen, if any. */
  viewedSessionPath: string | null;
  /** True while a view switch is in flight. */
  switching: boolean;
  /** sessionId → sessionFile, from the disk index AND the execution registry. */
  sessionIdToPath: ReadonlyMap<string, string>;
  /** Whether a transcript is displayed (landing shows none). */
  hasViewedSession: boolean;
  /** Streaming deltas render live only when enabled. */
  streamResponses: boolean;
}

export interface RuntimeEventPlan {
  /** Events to dispatch into the viewed transcript reducer. */
  dispatch: AgentEvent[];
  /** Per-path event-layer updates (execution rows, startedAt, approvals). */
  executions: Array<{ path: string; event: AgentEvent }>;
  /** Paths that finished work the user was not looking at. */
  unread: string[];
  /** The viewed conversation's engine state changed (model/thinking/rename). */
  refreshViewedState: boolean;
  /** The viewed conversation's transcript/stats are stale. */
  resyncViewed: boolean;
  /** Settles to refresh the goal strip, by (sessionId, cwd). */
  settleSessionIds: string[];
}

const EXECUTION_EVENTS = new Set([
  "agent_start",
  "agent_settled",
  "agent_end",
  "extension_ui_request",
  "extension_ui_cancel",
  "extension_ui_response",
]);

export function planRuntimeEvents(batch: readonly AgentEvent[], ctx: RuntimeEventContext): RuntimeEventPlan {
  const plan: RuntimeEventPlan = {
    dispatch: [],
    executions: [],
    unread: [],
    refreshViewedState: false,
    resyncViewed: false,
    settleSessionIds: [],
  };
  const seenSettle = new Set<string>();

  for (const event of batch) {
    if (!event || typeof event !== "object") continue;
    // Identity first: the event's own path, never a guessed fallback.
    const eventPath =
      typeof event.sessionFile === "string"
        ? event.sessionFile
        : typeof event.sessionId === "string"
          ? (ctx.sessionIdToPath.get(event.sessionId) ?? null)
          : null;
    const isViewed = eventPath != null && eventPath === ctx.viewedSessionPath;

    if (
      ctx.hasViewedSession &&
      (event.type !== "message_update" || ctx.streamResponses) &&
      shouldAcceptEvent(eventPath, { viewedSessionPath: ctx.viewedSessionPath, switching: ctx.switching })
    ) {
      plan.dispatch.push(event);
    }

    if (EXECUTION_EVENTS.has(event.type) && eventPath) {
      plan.executions.push({ path: eventPath, event });
      if (
        (event.type === "agent_settled" || event.type === "agent_end") &&
        eventPath !== ctx.viewedSessionPath &&
        !plan.unread.includes(eventPath)
      ) {
        plan.unread.push(eventPath);
      }
    }

    // View-scoped side effects only for the viewed conversation.
    if (
      isViewed &&
      (event.type === "agent_settled" || event.type === "agent_end" || event.type === "session_info_changed")
    ) {
      plan.refreshViewedState = true;
    }
    if (isViewed && event.type === "compaction_end" && !event.aborted) {
      plan.resyncViewed = true;
    }

    if (
      (event.type === "agent_end" || event.type === "agent_settled") &&
      typeof event.sessionId === "string" &&
      !seenSettle.has(event.sessionId)
    ) {
      seenSettle.add(event.sessionId);
      plan.settleSessionIds.push(event.sessionId);
    }
  }

  return plan;
}

/** Where an approval request belongs: its OWN session, or nowhere. A request
 *  with missing/unknown identity yields null, so no random viewed conversation
 *  is ever marked as waiting (C3). */
export function planApprovalRequest(
  sessionId: string | null | undefined,
  sessionIdToPath: ReadonlyMap<string, string>
): { path: string | null } {
  if (!sessionId) return { path: null };
  return { path: sessionIdToPath.get(sessionId) ?? null };
}
