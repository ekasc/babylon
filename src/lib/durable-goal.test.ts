import { describe, expect, it } from "vitest";
import {
  createDurableGoalState,
  defaultDurableGoalModeConfig,
  durableCompletedWithMarker,
  durableGoalElapsed,
  formatDurableElapsed,
  parseDurableGoalState,
  renderDurableGoalContext,
  slugify,
} from "./durable-goal";

describe("durable goal state", () => {
  it("creates a plannable goal with a started log entry", () => {
    const state = createDurableGoalState("Ship it", defaultDurableGoalModeConfig(), 1000);
    expect(state).toMatchObject({ active: true, paused: false, status: "planning", turnCount: 0, startedAt: new Date(1000).toISOString() });
    expect(state.log[0]).toMatchObject({ event: "started" });
  });

  it("parses stored state and rejects malformed files", () => {
    const state = createDurableGoalState("Ship it", defaultDurableGoalModeConfig(), 1000);
    expect(parseDurableGoalState(JSON.parse(JSON.stringify(state))))?.toMatchObject({ objective: "Ship it" });
    expect(parseDurableGoalState(null)).toBeNull();
    expect(parseDurableGoalState({ objective: "x" })).toBeNull();
    expect(parseDurableGoalState({ ...state, status: "flying" })).toBeNull();
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  it("tracks elapsed minus pauses and formats it", () => {
    const state = createDurableGoalState("Ship it", defaultDurableGoalModeConfig(), 0);
    expect(durableGoalElapsed({ ...state, startedAt: new Date(0).toISOString() }, 65_000)).toBe(65_000);
    expect(formatDurableElapsed(65_000)).toBe("1:05");
    expect(formatDurableElapsed(3_661_000)).toBe("1:01:01");
    const paused = { ...state, paused: true, pausedAt: new Date(30_000).toISOString(), pausedMs: 5_000 };
    expect(durableGoalElapsed(paused, 100_000)).toBe(25_000);
  });

  it("renders injection context and detects the completion marker", () => {
    const state = createDurableGoalState("Ship it", defaultDurableGoalModeConfig(), 0);
    const context = renderDurableGoalContext(state);
    expect(context).toContain("Objective: Ship it");
    expect(context).toContain("GOAL_DONE");
    expect(renderDurableGoalContext({ ...state, paused: true })).toBe("");
    expect(durableCompletedWithMarker("done stuff\nGOAL_DONE", "GOAL_DONE")).toBe(true);
    expect(durableCompletedWithMarker("GOAL_DONE here", "GOAL_DONE")).toBe(false);
  });
});
