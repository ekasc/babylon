import { describe, expect, it } from "vitest";
import {
  bumpGoalTurn,
  clearGoal,
  finishGoal,
  formatElapsed,
  goalElapsed,
  loadGoals,
  moveGoal,
  saveGoals,
  startGoal,
  type GoalMap,
} from "./goal-mode";

const memStore = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

describe("startGoal", () => {
  it("creates a zero-turn open goal and keeps the overlay position on restart", () => {
    const m = startGoal({}, "/s/a", "Ship it", 1000);
    expect(m["/s/a"]).toMatchObject({ objective: "Ship it", startedAt: 1000, turns: 0, done: false });
    const moved = moveGoal(m, "/s/a", { x: 10, y: 20 });
    const again = startGoal(moved, "/s/a", "Ship it v2", 2000);
    expect(again["/s/a"].pos).toEqual({ x: 10, y: 20 });
    expect(again["/s/a"].turns).toBe(0);
  });
  it("ignores blank objectives and paths", () => {
    expect(startGoal({}, "/s/a", "   ")).toEqual({});
    expect(startGoal({}, "", "Ship it")).toEqual({});
  });
});

describe("bumpGoalTurn", () => {
  it("counts only while a goal is open", () => {
    let m: GoalMap = startGoal({}, "/s/a", "Ship it");
    m = bumpGoalTurn(m, "/s/a");
    m = bumpGoalTurn(m, "/s/a");
    expect(m["/s/a"].turns).toBe(2);
    m = finishGoal(m, "/s/a", 5000);
    expect(bumpGoalTurn(m, "/s/a")).toBe(m);
    expect(bumpGoalTurn({}, "/s/a")).toEqual({});
  });
});

describe("finishGoal / clearGoal", () => {
  it("freezes the clock and clears cleanly", () => {
    let m: GoalMap = startGoal({}, "/s/a", "Ship it", 1000);
    m = finishGoal(m, "/s/a", 61000);
    expect(m["/s/a"].done).toBe(true);
    expect(goalElapsed(m["/s/a"], 999999)).toBe(60000);
    expect(finishGoal(m, "/s/a", 70000)).toBe(m);
    m = clearGoal(m, "/s/a");
    expect(m).toEqual({});
    expect(clearGoal(m, "/s/a")).toBe(m);
  });
});

describe("formatElapsed", () => {
  it("renders M:SS under an hour and H:MM:SS above", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65000)).toBe("1:05");
    expect(formatElapsed(3599999)).toBe("59:59");
    expect(formatElapsed(3600000)).toBe("1:00:00");
    expect(formatElapsed(7384000)).toBe("2:03:04");
  });
});

describe("persistence", () => {
  it("round-trips goals and rejects garbage", () => {
    const store = memStore();
    expect(loadGoals(store)).toEqual({});
    saveGoals(startGoal({}, "/s/a", "Ship it", 1000), store);
    expect(loadGoals(store)["/s/a"].objective).toBe("Ship it");
    const bad = memStore();
    bad.setItem("babylon:goal-mode:v1", "{nope");
    expect(loadGoals(bad)).toEqual({});
    const wrong = memStore();
    wrong.setItem("babylon:goal-mode:v1", "[1,2]");
    expect(loadGoals(wrong)).toEqual({});
  });
});
