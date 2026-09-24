import { describe, expect, it } from "vitest";
import { goalFileForSession } from "./store";
import { isSessionId } from "../../src/lib/durable-goal";

describe("goal session paths", () => {
  it("keys state per session under the project's goal-mode dir", () => {
    expect(goalFileForSession("/repo", "01a0c289-50e1-7bb2-8aa0-66dac27c85bc")).toBe(
      "/repo/.pi/state/goal-mode/sessions/01a0c289-50e1-7bb2-8aa0-66dac27c85bc.json"
    );
  });

  it("rejects hostile session ids instead of building paths", () => {
    expect(() => goalFileForSession("/repo", "../../etc")).toThrow(/invalid session id/);
    expect(() => goalFileForSession("/repo", "")).toThrow(/invalid session id/);
    expect(isSessionId("abc")).toBe(false);
    expect(isSessionId("01a0c289-50e1-7bb2-8aa0-66dac27c85bc")).toBe(true);
  });
});
