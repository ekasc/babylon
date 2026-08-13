import { describe, expect, it } from "vitest";
import { shouldAcceptEvent } from "./sessionLifecycle";

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
