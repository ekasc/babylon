import { describe, expect, it } from "vitest";
import { isAgentLive, shouldAcceptEvent } from "./sessionLifecycle";

describe("shouldAcceptEvent", () => {
  it("rejects all events while a session replacement is in flight", () => {
    expect(
      shouldAcceptEvent({ type: "message_update", sessionId: "old" }, {
        activeSessionId: "old",
        switching: true,
      })
    ).toBe(false);
  });

  it("accepts only events from the active live session", () => {
    const context = { activeSessionId: "session-b", switching: false };
    expect(shouldAcceptEvent({ type: "agent_start", sessionId: "session-b" }, context)).toBe(true);
    expect(shouldAcceptEvent({ type: "agent_settled", sessionId: "session-a" }, context)).toBe(false);
  });

  it("rejects stamped events until the first live session is known", () => {
    expect(
      shouldAcceptEvent({ type: "extension_ui_request", sessionId: "warming" }, {
        activeSessionId: null,
        switching: false,
      })
    ).toBe(false);
  });

  it("keeps compatibility with host-level events that have no session id", () => {
    expect(
      shouldAcceptEvent({ type: "host_notice" }, { activeSessionId: "session-a", switching: false })
    ).toBe(true);
  });
});

describe("isAgentLive", () => {
  it("is live while the transcript is streaming", () => {
    expect(isAgentLive({ streaming: true })).toBe(true);
  });

  it("stays live from host truth after a reload wipes transcript state", () => {
    // Reload mid-turn: fresh reducer (streaming=false) but the last hydrate
    // saw the host still running. Without the host flag the UI shows idle.
    expect(isAgentLive({ streaming: false, hostStreaming: true })).toBe(true);
  });

  it("is live for background activity and workflow runs", () => {
    expect(isAgentLive({ streaming: false, liveActivityCount: 2 })).toBe(true);
    expect(isAgentLive({ streaming: false, runningWorkflows: 1 })).toBe(true);
  });

  it("is idle when nothing runs anywhere", () => {
    expect(
      isAgentLive({ streaming: false, hostStreaming: false, liveActivityCount: 0, runningWorkflows: 0 })
    ).toBe(false);
    expect(isAgentLive({ streaming: false })).toBe(false);
  });
});
