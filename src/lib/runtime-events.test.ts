// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { AgentEvent, RuntimeStatus } from "../bridge";
import { useRuntimeHealth } from "./runtime-health";
import { planApprovalRequest, planRuntimeEvents } from "./runtime-events";

const ev = (over: Partial<AgentEvent> & { type: string }): AgentEvent => over as unknown as AgentEvent;
const ids = new Map([["sid-a", "/a.json"]]);

const ctx = (over: Partial<Parameters<typeof planRuntimeEvents>[1]> = {}) => ({
  viewedSessionPath: null as string | null,
  switching: false,
  sessionIdToPath: ids,
  hasViewedSession: false,
  streamResponses: false,
  ...over,
});

describe("runtime health binding", () => {
  it("updates health and reports errors — and has no navigation surface", () => {
    let publish!: (s: RuntimeStatus) => void;
    const subscribe = vi.fn((cb: (s: RuntimeStatus) => void) => {
      publish = cb;
      return () => undefined;
    });
    const onError = vi.fn();
    const { result, rerender } = renderHook(() => useRuntimeHealth({ subscribe, onError }));

    act(() => publish({ status: "ready" }));
    expect(result.current).toEqual({ status: "ready" });
    act(() => publish({ status: "error", message: "boom" }));
    expect(result.current).toEqual({ status: "error", message: "boom" });
    expect(onError).toHaveBeenCalledWith("boom");

    // The hook returns a status and nothing else: there is no way for a
    // health update to reach view state from here.
    expect(Object.keys(result.current).sort()).toEqual(["message", "status"]);
    rerender();
  });

  it("strips identity smuggled through the REAL subscription path", () => {
    // The production hook, not just the policy: an IPC payload carrying a
    // session/cwd must not survive into renderer state.
    let publish!: (s: RuntimeStatus) => void;
    const { result } = renderHook(() =>
      useRuntimeHealth({
        subscribe: (cb) => {
          publish = cb;
          return () => undefined;
        },
      })
    );
    act(() => publish({ status: "ready", sessionFile: "/a.json", cwd: "/p" } as unknown as RuntimeStatus));
    expect(result.current).toEqual({ status: "ready" });
  });

  it("keeps ONE subscription when callers build fresh deps objects each render", () => {
    // App creates a new deps object every render; resubscribing on that
    // identity would churn the health listener constantly.
    const subscribe = vi.fn(() => () => undefined);
    const onError = vi.fn();
    const { rerender } = renderHook(() => useRuntimeHealth({ subscribe, onError }));
    rerender();
    rerender();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("derives health from the daemon connection when one is wired", () => {
    let connected!: (v: boolean) => void;
    const { result } = renderHook(() =>
      useRuntimeHealth({
        subscribe: () => () => undefined,
        subscribeConnection: (cb) => {
          connected = cb;
          return () => undefined;
        },
      })
    );
    expect(result.current.status).toBe("starting");
    act(() => connected(true));
    expect(result.current.status).toBe("ready");
    act(() => connected(false));
    expect(result.current.status).toBe("starting");
  });
});

describe("runtime event planning", () => {
  it("always plans background bookkeeping, even with nothing on screen", () => {
    const plan = planRuntimeEvents([ev({ type: "agent_start", sessionFile: "/a.json" })], ctx());
    expect(plan.dispatch).toEqual([]);
    expect(plan.executions).toHaveLength(1);
    expect(plan.executions[0]?.path).toBe("/a.json");
  });

  it("still plans background bookkeeping while LANDING is displayed", () => {
    // The regression this replaces: an early return dropped every event while
    // no transcript was on screen, so background Spaces went silent.
    const plan = planRuntimeEvents(
      [
        ev({ type: "agent_start", sessionFile: "/a.json" }),
        ev({ type: "agent_settled", sessionFile: "/a.json" }),
      ],
      ctx({ viewedSessionPath: null, hasViewedSession: false })
    );
    expect(plan.executions).toHaveLength(2);
    expect(plan.unread).toEqual(["/a.json"]);
  });

  it("dispatches only the viewed conversation's own events", () => {
    const plan = planRuntimeEvents(
      [
        ev({ type: "message_update", sessionFile: "/a.json", text: "a" }),
        ev({ type: "message_update", sessionFile: "/b.json", text: "b" }),
      ],
      ctx({ viewedSessionPath: "/b.json", hasViewedSession: true, streamResponses: true })
    );
    expect(plan.dispatch.map((e) => e.sessionFile)).toEqual(["/b.json"]);
  });

  it("drops an event whose identity cannot be resolved", () => {
    const plan = planRuntimeEvents(
      [ev({ type: "message_update", sessionId: "unknown" })],
      ctx({ viewedSessionPath: "/b.json", hasViewedSession: true })
    );
    expect(plan.dispatch).toEqual([]);
  });

  it("suppresses mid-stream deltas when streaming is off", () => {
    const plan = planRuntimeEvents(
      [ev({ type: "message_update", sessionFile: "/b.json" })],
      ctx({ viewedSessionPath: "/b.json", hasViewedSession: true, streamResponses: false })
    );
    expect(plan.dispatch).toEqual([]);
  });

  it("scopes state refresh and resync to the viewed conversation", () => {
    const background = planRuntimeEvents(
      [
        ev({ type: "agent_settled", sessionFile: "/a.json" }),
        ev({ type: "compaction_end", sessionFile: "/a.json" }),
      ],
      ctx({ viewedSessionPath: "/b.json", hasViewedSession: true })
    );
    expect(background.refreshViewedState).toBe(false);
    expect(background.resyncViewed).toBe(false);

    const viewed = planRuntimeEvents(
      [
        ev({ type: "agent_settled", sessionFile: "/b.json" }),
        ev({ type: "compaction_end", sessionFile: "/b.json" }),
      ],
      ctx({ viewedSessionPath: "/b.json", hasViewedSession: true })
    );
    expect(viewed.refreshViewedState).toBe(true);
    expect(viewed.resyncViewed).toBe(true);
  });

  it("names the settled sessions for goal/design refresh, once each", () => {
    const plan = planRuntimeEvents(
      [
        ev({ type: "agent_settled", sessionFile: "/a.json", sessionId: "sid-a" }),
        ev({ type: "agent_end", sessionFile: "/a.json", sessionId: "sid-a" }),
      ],
      ctx()
    );
    expect(plan.settleSessionIds).toEqual(["sid-a"]);
  });
});

describe("extension notifications and errors are addressed events", () => {
  it("dispatches a stamped extension notify to the viewed conversation", () => {
    // PiHost stamps these now; the planner must accept them like any other
    // addressed event, or user-visible extension notices vanish.
    const plan = planRuntimeEvents(
      [ev({ type: "extension_ui_request", method: "notify", message: "HELLO", sessionFile: "/b.json", sessionId: "sid-b" })],
      ctx({ viewedSessionPath: "/b.json", hasViewedSession: true })
    );
    expect(plan.dispatch).toHaveLength(1);
  });

  it("dispatches a stamped extension error to the viewed conversation", () => {
    const plan = planRuntimeEvents(
      [ev({ type: "extension_error", error: "boom", sessionFile: "/b.json", sessionId: "sid-b" })],
      ctx({ viewedSessionPath: "/b.json", hasViewedSession: true })
    );
    expect(plan.dispatch).toHaveLength(1);
  });

  it("still drops unstamped ones — identity is required", () => {
    const plan = planRuntimeEvents(
      [ev({ type: "extension_ui_request", method: "notify", message: "HELLO" })],
      ctx({ viewedSessionPath: "/b.json", hasViewedSession: true })
    );
    expect(plan.dispatch).toEqual([]);
  });
});

describe("approval request planning", () => {
  it("attributes a request to its own session", () => {
    expect(planApprovalRequest("sid-a", ids).path).toBe("/a.json");
  });
  it("never attributes a request with missing or unknown identity", () => {
    expect(planApprovalRequest(null, ids).path).toBeNull();
    expect(planApprovalRequest(undefined, ids).path).toBeNull();
    expect(planApprovalRequest("nope", ids).path).toBeNull();
  });
});
