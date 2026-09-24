import { describe, expect, it } from "vitest";
import {
  isSessionNotFound,
  SESSION_NOT_FOUND_MESSAGE,
  SessionNotFoundError,
} from "./errors";

describe("isSessionNotFound", () => {
  it("matches the class, code-carrying serializations, and the stable message", () => {
    expect(isSessionNotFound(new SessionNotFoundError())).toBe(true);
    expect(isSessionNotFound(new SessionNotFoundError("/x/y.jsonl"))).toBe(true);
    // Boundaries that strip everything but a code-shaped payload.
    expect(isSessionNotFound({ code: "SESSION_NOT_FOUND", message: "gone" })).toBe(true);
    // Boundaries that strip everything but the message.
    expect(isSessionNotFound(new Error(SESSION_NOT_FOUND_MESSAGE))).toBe(true);
    expect(isSessionNotFound(new Error(`${SESSION_NOT_FOUND_MESSAGE}: /x/y.jsonl`))).toBe(true);
    expect(isSessionNotFound(SESSION_NOT_FOUND_MESSAGE)).toBe(true);
  });

  it("rejects other failures, including near-miss prose", () => {
    expect(isSessionNotFound(new Error("invalid session path"))).toBe(false);
    expect(isSessionNotFound(new Error("session path is outside the pi sessions directory"))).toBe(false);
    expect(isSessionNotFound(new Error("session path does not exist eventually"))).toBe(false);
    expect(isSessionNotFound({ code: "ENOENT" })).toBe(false);
    expect(isSessionNotFound(null)).toBe(false);
    expect(isSessionNotFound(undefined)).toBe(false);
  });
});
