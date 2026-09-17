import { createBabylonEvent, type BabylonEvent, type BabylonEventType } from "./events";
import { stampOwnership } from "./ownership";

function mapAgentEventType(type: unknown): BabylonEventType | null {
  switch (type) {
    case "agent_start":
      return "turn.started";
    case "agent_end":
      return "turn.completed";
    case "tool_execution_start":
      return "tool.started";
    case "tool_execution_end":
      return "tool.completed";
    case "pideck_checkpoint_created":
      return "checkpoint.created";
    default:
      return null;
  }
}

/**
 * Build a Babylon event from a real Pi engine event. Ownership uses the
 * runtime identity carried by the event itself (sessionId, toolCallId), never
 * whichever session happens to be open in the UI. Payloads stay flat ids and
 * flags; no prompt text or tool output ever enters the log.
 */
export function babylonEventFromAgentEvent(event: any): BabylonEvent | null {
  const type = mapAgentEventType(event?.type);
  if (!type) return null;
  const sessionId =
    typeof event.sessionId === "string" && event.sessionId ? event.sessionId : undefined;
  const toolCallId =
    typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : undefined;
  const owner = stampOwnership({
    ...(sessionId ? { sessionId } : {}),
    ...(toolCallId ? { toolRunId: toolCallId } : {}),
  });
  const payload: Record<string, string | number | boolean> = {};
  if (toolCallId && (type === "tool.started" || type === "tool.completed")) {
    payload.toolCallId = toolCallId;
  }
  if (type === "tool.completed" && typeof event.isError === "boolean") {
    payload.isError = event.isError;
  }
  if (type === "checkpoint.created" && typeof event.userEntryId === "string" && event.userEntryId) {
    payload.id = event.userEntryId;
  }
  return createBabylonEvent(type, { owner, payload });
}
