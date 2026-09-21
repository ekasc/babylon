// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { bridge } from "../../bridge";
import { useDurableGoal } from "./useDurableGoal";
import type { DurableGoalState } from "../../lib/durable-goal";

const toast = vi.fn();

function goal(objective: string): DurableGoalState {
  return {
    active: true,
    paused: false,
    objective,
    slug: "x",
    status: "executing",
    currentStep: "",
    startedAt: new Date(0).toISOString(),
    acceptanceCriteria: [],
    nonGoals: [],
    completedSteps: [],
    evidence: [],
    log: [],
  };
}

beforeEach(() => {
  toast.mockClear();
});

describe("useDurableGoal", () => {
  it("refreshes the goal for a session", async () => {
    const spy = vi.spyOn(bridge, "goalGet").mockResolvedValue({ goal: goal("Ship it") });
    try {
      const { result } = renderHook(() => useDurableGoal(toast));
      await act(async () => {
        await result.current.refreshDurableGoal("s1", "/repo");
      });
      expect(result.current.durableGoal?.objective).toBe("Ship it");
    } finally {
      spy.mockRestore();
    }
  });

  it("drops a stale refresh when the session switched mid-flight", async () => {
    const releases = new Map<string, (value: { goal: DurableGoalState | null }) => void>();
    const spy = vi
      .spyOn(bridge, "goalGet")
      .mockImplementation(
        (sessionId: string) => new Promise((resolve) => releases.set(sessionId, resolve))
      );
    try {
      const { result } = renderHook(() => useDurableGoal(toast));
      await act(async () => {
        const first = result.current.refreshDurableGoal("s1", "/repo");
        const second = result.current.refreshDurableGoal("s2", "/repo");
        releases.get("s2")!({ goal: goal("current session") });
        await second;
        // The s1 response lands late, after s2 won: must not overwrite.
        releases.get("s1")!({ goal: goal("stale session") });
        await first;
      });
      expect(result.current.durableGoal?.objective).toBe("current session");
    } finally {
      spy.mockRestore();
    }
  });

  it("adopts control results and toasts on failure", async () => {
    const control = vi.spyOn(bridge, "goalControl").mockResolvedValue({ goal: goal("Paused") });
    try {
      const { result } = renderHook(() => useDurableGoal(toast));
      await act(async () => {
        await result.current.goalControl("pause");
      });
      expect(result.current.durableGoal?.objective).toBe("Paused");
      expect(toast).not.toHaveBeenCalled();
    } finally {
      control.mockRestore();
    }
    const failing = vi.spyOn(bridge, "goalControl").mockRejectedValue(new Error("down"));
    try {
      const { result } = renderHook(() => useDurableGoal(toast));
      await act(async () => {
        await result.current.goalControl("pause");
      });
      expect(toast).toHaveBeenCalledWith("error", "down");
    } finally {
      failing.mockRestore();
    }
  });
});
