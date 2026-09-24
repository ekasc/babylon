// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { bridge } from "../../bridge";
import type { DesignStatus } from "../../../electron/design-mode/store";
import { useDesignMode } from "./useDesignMode";
import { createDesignState } from "../../../electron/design-mode/store";

const toast = vi.fn();

beforeEach(() => {
  toast.mockClear();
});

describe("useDesignMode", () => {
  it("refreshes the design status for a session", async () => {
    const design = createDesignState("Us screen", "us-screen");
    const spy = vi.spyOn(bridge, "designGet").mockResolvedValue({ design, stage: "elicit", maxRounds: 3 });
    try {
      const { result } = renderHook(() => useDesignMode(toast));
      await act(async () => {
        await result.current.refreshDesign("s1", "/repo");
      });
      expect(result.current.designStatus?.design?.subject).toBe("Us screen");
      expect(result.current.designStatus?.stage).toBe("elicit");
    } finally {
      spy.mockRestore();
    }
  });

  it("adopts the fresh status from control and toasts on failure", async () => {
    const design = { ...createDesignState("Us screen", "us-screen"), briefApproved: true };
    const spy = vi.spyOn(bridge, "designControl").mockResolvedValue({ design, stage: "direction", maxRounds: 3 });
    try {
      const { result } = renderHook(() => useDesignMode(toast));
      await act(async () => {
        await result.current.designControl("/s/session.jsonl", "approve-brief");
      });
      expect(spy).toHaveBeenCalledWith("/s/session.jsonl", "approve-brief");
      expect(result.current.designStatus?.stage).toBe("direction");
      expect(toast).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const failing = vi.spyOn(bridge, "designControl").mockRejectedValue(new Error("down"));
    try {
      const { result } = renderHook(() => useDesignMode(toast));
      await act(async () => {
        await result.current.designControl("/s/session.jsonl", "approve-brief");
      });
      expect(toast).toHaveBeenCalledWith("error", "down");
    } finally {
      failing.mockRestore();
    }
  });

  it("drops a stale refresh when the session switched mid-flight", async () => {
    const releases = new Map<string, (value: DesignStatus) => void>();
    const spy = vi
      .spyOn(bridge, "designGet")
      .mockImplementation(
        (sessionId: string) =>
          new Promise<DesignStatus>((resolve) => releases.set(sessionId, resolve))
      );
    try {
      const { result } = renderHook(() => useDesignMode(toast));
      await act(async () => {
        const first = result.current.refreshDesign("s1", "/repo");
        const second = result.current.refreshDesign("s2", "/repo");
        releases.get("s2")!({ design: createDesignState("Current", "current"), stage: "elicit", maxRounds: 3 });
        await second;
        // The s1 response lands late, after s2 won: must not overwrite.
        releases.get("s1")!({ design: createDesignState("Stale", "stale"), stage: "elicit", maxRounds: 3 });
        await first;
      });
      expect(result.current.designStatus?.design?.subject).toBe("Current");
    } finally {
      spy.mockRestore();
    }
  });
});
