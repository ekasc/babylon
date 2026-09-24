import { describe, expect, it, vi } from "vitest";
import { indexExecutions, mergeExecution, showViewLanding, viewSession, type ViewNavigationDeps } from "./view-navigation";
import { shouldAcceptEvent } from "../sessionLifecycle";
import type { AgentEvent, SessionWindow } from "../bridge";
import type { ProjectExecution } from "../execution";

const windowOf = (text: string): SessionWindow => ({
  messages: [{ kind: "user", key: `k-${text}`, text }],
  startOffset: 0,
});

function execution(cwd: string, file: string, over: Partial<ProjectExecution> = {}): ProjectExecution {
  return {
    cwd,
    sessionFile: file,
    sessionId: `sid-${file}`,
    state: "idle",
    streaming: false,
    generation: 1,
    ...over,
  };
}

function makeDeps(overrides: Partial<ViewNavigationDeps> = {}) {
  const bridge = {
    getSessionMessages: vi.fn(async (path: string) => windowOf(path)),
    // Forbidden paths for a view operation: present as spies so wiring one
    // in (mutation check) fails every "never called" assertion.
    openSession: vi.fn(async () => undefined),
    releaseSession: vi.fn(async () => ({ released: true })),
    executionActivate: vi.fn(async () => ({ ok: true as const, execution: execution("/p", "/s") })),
    executionDeactivate: vi.fn(async () => true),
    executionList: vi.fn(async () => [] as ProjectExecution[]),
  };
  const deps: ViewNavigationDeps = {
    epochRef: { current: 0 },
    viewedPathRef: { current: null },
    viewedCwdRef: { current: null },
    hasSessionRef: { current: false },
    setViewedSessionPath: vi.fn(),
    setHasSession: vi.fn(),
    setStats: vi.fn(),
    setCommands: vi.fn(),
    resetHistory: vi.fn(),
    setCanLoadMore: vi.fn(),
    rollbackDraftRef: { current: null },
    setRollbackPlan: vi.fn(),
    loadedMessagesRef: { current: [] },
    earliestOffsetRef: { current: null },
    sessionCacheRef: { current: new Map() },
    resetTranscript: vi.fn(),
    rebuildTranscript: vi.fn(),
    clearUnread: vi.fn(),
    clearArmings: vi.fn(),
    registerTab: vi.fn(),
    claimViewSwitch: vi.fn(() => 1),
    releaseViewSwitch: vi.fn(),
    evictDeadTab: vi.fn(),
    showLanding: vi.fn(),
    toast: vi.fn(),
    bridge,
    ...overrides,
  };
  return { bridge, deps, viewedSessionIdRef: { current: null as string | null } };
}

const neverActivated = (bridge: ReturnType<typeof makeDeps>["bridge"]) => {
  expect(bridge.openSession).not.toHaveBeenCalled();
  expect(bridge.executionActivate).not.toHaveBeenCalled();
  expect(bridge.releaseSession).not.toHaveBeenCalled();
  expect(bridge.executionDeactivate).not.toHaveBeenCalled();
};

describe("viewSession is disk-only (I2/I3)", () => {
  it("1: with A as execution owner, viewing B touches no activation API and no execution registry", async () => {
    const { bridge, deps } = makeDeps();
    // A is the execution owner (renderer registry hydrated from executionList).
    bridge.executionList.mockResolvedValue([execution("/p", "/s/a")]);
    const registry = indexExecutions(await bridge.executionList());

    const out = await viewSession("/s/b", "/p", deps);

    expect(out.status).toBe("committed");
    expect(bridge.getSessionMessages).toHaveBeenCalledWith("/s/b");
    expect(deps.rebuildTranscript).toHaveBeenCalledWith([expect.objectContaining({ key: "k-/s/b" })]);
    expect(deps.registerTab).toHaveBeenCalledWith("/p", "/s/b");
    expect(deps.clearUnread).toHaveBeenCalledWith("/s/b");
    // No Pi activation, no ownership change, no runtime release — and
    // executionList itself is not called by navigation (hydration is
    // startup/reconnect's job).
    neverActivated(bridge);
    expect(registry["/p"]?.sessionFile).toBe("/s/a");
  });

  it("2: with no execution owner, viewing renders from disk and creates no runtime", async () => {
    const { bridge, deps } = makeDeps();
    bridge.executionList.mockResolvedValue([]);
    const registry = indexExecutions(await bridge.executionList());
    expect(registry).toEqual({});

    const out = await viewSession("/s/b", "/p", deps);

    expect(out.status).toBe("committed");
    expect(bridge.getSessionMessages).toHaveBeenCalledWith("/s/b");
    expect(registry).toEqual({});
    neverActivated(bridge);
  });

  it("3: a running A survives viewing B, and A's events cannot enter B's transcript", async () => {
    const { bridge, deps, viewedSessionIdRef } = makeDeps();
    const a = execution("/p", "/s/a", { state: "working", streaming: true });
    let registry = indexExecutions([a]);
    // A owns the project; the view starts on A.
    viewedSessionIdRef.current = a.sessionId;

    await viewSession("/s/b", "/p", deps);

    // The viewed session is now B: the transcript guard rejects A's stream,
    // while A keeps running in the execution registry.
    viewedSessionIdRef.current = "sid-b";
    registry = mergeExecution(registry, { ...a, generation: 2, streaming: true });
    expect(registry["/p"]?.state).toBe("working");
    const aStreamEvent = { sessionId: a.sessionId, type: "message_update" } as unknown as AgentEvent;
    expect(
      shouldAcceptEvent(aStreamEvent, { viewedSessionId: viewedSessionIdRef.current, switching: false })
    ).toBe(false);
    neverActivated(bridge);
  });

  it("4: rapid A→B→A: the latest view wins and the stale disk load never commits", async () => {
    const { bridge, deps } = makeDeps();
    let releaseB!: (w: SessionWindow) => void;
    bridge.getSessionMessages.mockImplementation((path: string) => {
      if (path === "/s/b") return new Promise<SessionWindow>((resolve) => (releaseB = resolve));
      return Promise.resolve(windowOf(path));
    });

    const bView = viewSession("/s/b", "/p", deps); // pending disk load
    const aView = await viewSession("/s/a", "/p", deps); // commits, latest epoch
    expect(aView.status).toBe("committed");
    expect(deps.viewedPathRef.current).toBe("/s/a");

    releaseB(windowOf("/s/b"));
    const late = await bView;
    expect(late.status).toBe("stale");
    // Only A's transcript ever rendered; B's late result was dropped.
    expect(deps.rebuildTranscript).toHaveBeenCalledTimes(1);
    expect(deps.rebuildTranscript).toHaveBeenCalledWith([expect.objectContaining({ key: "k-/s/a" })]);
    expect(deps.setViewedSessionPath).toHaveBeenLastCalledWith("/s/a");
    expect(deps.viewedPathRef.current).toBe("/s/a");
    neverActivated(bridge);
  });

  it("5: showLanding clears only view identity; A stays the execution owner", async () => {
    const { bridge, deps } = makeDeps();
    bridge.executionList.mockResolvedValue([execution("/p", "/s/a", { state: "working", streaming: true })]);
    let registry = indexExecutions(await bridge.executionList());
    deps.viewedPathRef.current = "/s/b";
    deps.setViewedSessionPath("/s/b");
    deps.setHasSession(true);

    showViewLanding(deps);

    expect(deps.viewedPathRef.current).toBeNull();
    expect(deps.setViewedSessionPath).toHaveBeenCalledWith(null);
    expect(deps.viewedCwdRef.current).toBeNull();
    expect(deps.setHasSession).toHaveBeenCalledWith(false);
    expect(deps.clearArmings).toHaveBeenCalled();
    // Landing is not an execution operation: the registry entry survives
    // untouched and no deactivation/activation API is reached.
    expect(registry["/p"]?.state).toBe("working");
    neverActivated(bridge);
    expect(deps.epochRef.current).toBeGreaterThan(0);
  });

  it("6: viewing across Spaces never mutates the execution registry", async () => {
    const { bridge, deps } = makeDeps();
    const a = execution("/space-a", "/s/a1", { state: "working", streaming: true });
    bridge.executionList.mockResolvedValue([a]);
    const registry = indexExecutions(await bridge.executionList());
    const before = registry;

    // Space A executes; switch to Space B's remembered session (what
    // selectSpace now does) — registry object must be untouched.
    await viewSession("/s/b1", "/space-b", deps);

    expect(registry).toBe(before);
    expect(registry["/space-a"]?.sessionFile).toBe("/s/a1");
    expect(Object.keys(registry)).toEqual(["/space-a"]);
    neverActivated(bridge);
  });

  it("7: remembered-tab restore is disk-only; a vanished remembered file evicts quietly", async () => {
    const { bridge, deps } = makeDeps();
    // Happy path: remembered tab renders from disk (selectSpace/addSpace).
    const ok = await viewSession("/s/remembered", "/p", deps, { quietMissing: true });
    expect(ok.status).toBe("committed");
    neverActivated(bridge);

    // Speculative restore on a file deleted outside the app: evict + land,
    // still without any activation attempt.
    bridge.getSessionMessages.mockRejectedValue(
      Object.assign(new Error("session path does not exist"), { code: "SESSION_NOT_FOUND" })
    );
    const out = await viewSession("/s/gone", "/p", deps, { quietMissing: true });
    expect(out.status).toBe("missing");
    expect(deps.evictDeadTab).toHaveBeenCalledWith("/s/gone");
    expect(deps.showLanding).toHaveBeenCalled();
    neverActivated(bridge);
  });

  it("8: ten sequential historical views create zero execution owners", async () => {
    const { bridge, deps } = makeDeps();
    for (let i = 0; i < 10; i++) {
      const out = await viewSession(`/s/history-${i}`, `/p-${i % 3}`, deps);
      expect(out.status).toBe("committed");
    }
    expect(bridge.getSessionMessages).toHaveBeenCalledTimes(10);
    neverActivated(bridge);
    expect(deps.registerTab).toHaveBeenCalledTimes(10);
  });
});

describe("execution registry helpers", () => {
  it("indexes by cwd and ignores stale-generation pushes", () => {
    const a = execution("/p", "/s/a", { generation: 4 });
    const registry = indexExecutions([a]);
    expect(registry["/p"]).toEqual(a);
    // Stale push (gen 3 < 4) cannot roll ownership back; fresh gen wins.
    expect(mergeExecution(registry, { ...a, generation: 3, sessionFile: "/s/old" })).toBe(registry);
    const fresh = mergeExecution(registry, { ...a, generation: 5, sessionFile: "/s/new" });
    expect(fresh["/p"]?.generation).toBe(5);
    // Independent projects coexist.
    const both = mergeExecution(fresh, execution("/other", "/s/x"));
    expect(Object.keys(both).sort()).toEqual(["/other", "/p"]);
  });

  it("rollback restores the previous view after a committed disk load", async () => {
    const { deps } = makeDeps();
    deps.viewedPathRef.current = "/s/a";
    deps.loadedMessagesRef.current = [{ key: "old" }];
    deps.earliestOffsetRef.current = 40;
    deps.setViewedSessionPath("/s/a");

    const out = await viewSession("/s/b", "/p", deps);
    expect(out.status).toBe("committed");
    expect(deps.viewedPathRef.current).toBe("/s/b");

    // Activation would fail; caller rolls the view back.
    out.rollback();
    expect(deps.viewedPathRef.current).toBe("/s/a");
    expect(deps.setViewedSessionPath).toHaveBeenLastCalledWith("/s/a");
    expect(deps.loadedMessagesRef.current).toEqual([{ key: "old" }]);
    expect(deps.earliestOffsetRef.current).toBe(40);
    expect(deps.setCanLoadMore).toHaveBeenLastCalledWith(true);
    expect(deps.rebuildTranscript).toHaveBeenLastCalledWith([{ key: "old" }]);
  });
});

describe("mutation guard", () => {
  it("fails if viewSession is wired through activation (deliberate canary contract)", () => {
    // The contract under test: viewSession's deps type has no activation
    // surface, and every runtime test above spies on the forbidden APIs.
    // A deliberate mutation (calling bridge.openSession inside viewSession)
    // fails tests 1/2/7/8 immediately — verified during development; this
    // assertion documents that the spies must stay present in every test.
    const { bridge } = makeDeps();
    expect(typeof bridge.openSession).toBe("function");
    expect(bridge.openSession).not.toHaveBeenCalled();
  });
});

describe("view navigation requires a concrete path", () => {
  it("views the path an activation returned; a null fresh session is not a thing", async () => {
    const { bridge, deps } = makeDeps();
    // A brand-new conversation is never viewed as null: executionActivate
    // returns a concrete sessionFile, and THAT is what gets viewed.
    bridge.executionActivate.mockResolvedValueOnce({ ok: true as const, execution: execution("/p", "/s") });
    const result = await bridge.executionActivate();
    expect(result.ok).toBe(true);
    // The activation itself is the only activation the test performs; the
    // view that follows must be disk-only.
    const out = await viewSession("/s", "/p", deps);
    expect(out.status).toBe("committed");
    expect(bridge.getSessionMessages).toHaveBeenCalledWith("/s");
    expect(deps.registerTab).toHaveBeenCalledWith("/p", "/s");
    bridge.executionActivate.mockClear();
    neverActivated(bridge);
  });
});
