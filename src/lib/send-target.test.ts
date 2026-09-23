import { describe, expect, it } from "vitest";
import { resolveSendTarget } from "./send-target";

describe("resolveSendTarget", () => {
  it("returns the live path when the epoch is unchanged", () => {
    expect(resolveSendTarget(5, 5, "/sessions/n.jsonl")).toBe("/sessions/n.jsonl");
  });

  it("rejects when a newer switch started while waiting", () => {
    // A → New Session → send before ready, then a switch to B: the send
    // must fail loudly, never prompt the stale session.
    expect(() => resolveSendTarget(5, 6, "/sessions/n.jsonl")).toThrow(
      "session changed before the message could be sent"
    );
  });

  it("rejects when no session is live yet", () => {
    expect(() => resolveSendTarget(5, 5, null)).toThrow("session is not ready");
  });

  it("prefers the live ref over any previously rendered path", () => {
    // The regression: closure held A's path while the ref already moved to
    // the new session. The helper only ever sees the ref value.
    expect(resolveSendTarget(5, 5, "/sessions/new.jsonl")).toBe("/sessions/new.jsonl");
    expect(resolveSendTarget(5, 5, "/sessions/new.jsonl")).not.toBe("/sessions/a.jsonl");
  });
});
