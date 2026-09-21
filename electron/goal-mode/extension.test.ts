import { describe, expect, it } from "vitest";
import { GOAL_INLINE_PATH, isExternalGoalModeExtension } from "./extension";

describe("isExternalGoalModeExtension", () => {
  it("keeps the hardbaked inline copy", () => {
    expect(
      isExternalGoalModeExtension({ path: GOAL_INLINE_PATH, resolvedPath: GOAL_INLINE_PATH, commands: new Map([["goal", {}]]) })
    ).toBe(false);
  });

  it("drops extensions registering the goal command", () => {
    expect(
      isExternalGoalModeExtension({ path: "/users/x/.pi/extensions/other", commands: new Map([["goal", {}]]) })
    ).toBe(true);
  });

  it("drops goal-mode directories by path as a fallback", () => {
    expect(isExternalGoalModeExtension({ path: "/users/x/.pi/extensions/goal-mode" })).toBe(true);
    expect(isExternalGoalModeExtension({ resolvedPath: "/repo/.pi/extensions/goal-mode/index.ts" })).toBe(true);
  });

  it("keeps unrelated extensions", () => {
    expect(isExternalGoalModeExtension({ path: "/x/snapcompact", commands: new Map() })).toBe(false);
    expect(isExternalGoalModeExtension({})).toBe(false);
  });
});
