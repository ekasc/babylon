import { describe, expect, it } from "vitest";
import { isAgentLive, shouldAcceptEvent } from "./sessionLifecycle";

describe("shouldAcceptEvent", () => {
  it("rejects every event while a view switch is in flight", () => {
    expect(shouldAcceptEvent("/a.json", { viewedSessionPath: "/a.json", switching: true })).toBe(false);
  });

  it("accepts only the event whose path IS the viewed conversation", () => {
    const context = { viewedSessionPath: "/b.json", switching: false };
    expect(shouldAcceptEvent("/b.json", context)).toBe(true);
    expect(shouldAcceptEvent("/a.json", context)).toBe(false);
  });

  it("rejects events when nothing is being viewed", () => {
    expect(shouldAcceptEvent("/a.json", { viewedSessionPath: null, switching: false })).toBe(false);
  });

  it("drops events whose path could not be resolved from their own identity", () => {
    expect(shouldAcceptEvent(null, { viewedSessionPath: "/b.json", switching: false })).toBe(false);
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
