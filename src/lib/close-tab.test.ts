import { describe, expect, it, vi } from "vitest";
import { performCloseTab, type CloseTabDeps } from "./close-tab";
import { returnToExecution } from "./composer-execution";
import type { ProjectExecution } from "../execution";

function exec(file: string, state: ProjectExecution["state"] = "idle"): ProjectExecution {
  return { cwd: "/p", sessionFile: file, sessionId: `sid-${file}`, state, streaming: state === "working", generation: 1 };
}

function makeDeps(over: Partial<CloseTabDeps> = {}) {
  const bridge = {
    releaseSession: vi.fn(),
    executionDeactivate: vi.fn(),
    executionActivate: vi.fn(),
    openSession: vi.fn(),
    abort: vi.fn(),
  };
  const executionsByCwd: Record<string, ProjectExecution> = {};
  const deps: CloseTabDeps = {
    navTabs: { tabs: [], activeBySpace: {} },
    setNavTabs: vi.fn(),
    viewedPathRef: { current: null },
    sessionByPath: new Map(),
    pinnedOrder: [],
    viewSession: vi.fn(),
    showLanding: vi.fn(),
    bridge,
    executionsByCwd,
    ...over,
  };
  return { deps, bridge, executionsByCwd };
}

const neverTouchedRuntime = (bridge: ReturnType<typeof makeDeps>["bridge"], viewSession: unknown, showLanding: unknown) => {
  expect(bridge.releaseSession).not.toHaveBeenCalled();
  expect(bridge.executionDeactivate).not.toHaveBeenCalled();
  expect(bridge.executionActivate).not.toHaveBeenCalled();
  expect(bridge.openSession).not.toHaveBeenCalled();
  expect(bridge.abort).not.toHaveBeenCalled();
  void viewSession;
  void showLanding;
};

describe("performCloseTab is pure navigation (I5)", () => {
  const tabA = { path: "/s/a", cwd: "/p" };
  const tabB = { path: "/s/b", cwd: "/p" };

  it("1+5: closing a non-selected historical tab removes it with zero navigation and zero runtime calls", () => {
    const { deps, bridge } = makeDeps({
      navTabs: { tabs: [tabA, tabB], activeBySpace: { "/p": "/s/a" } },
      viewedPathRef: { current: "/s/a" },
    });
    const out = performCloseTab(deps, "/s/b");
    expect(out).toEqual({ removed: true, navigated: false });
    expect(deps.viewedPathRef.current).toBe("/s/a");
    expect(deps.viewSession).not.toHaveBeenCalled();
    expect(deps.showLanding).not.toHaveBeenCalled();
    expect((deps.setNavTabs as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].tabs).toEqual([tabA]);
    neverTouchedRuntime(bridge, deps.viewSession, deps.showLanding);
  });

  for (const state of ["idle", "working", "approval"] as const) {
    it(`2-4: closing the ${state} execution-owner tab is allowed and never touches runtime or registry`, () => {
      const { deps, bridge, executionsByCwd } = makeDeps({
        navTabs: { tabs: [tabA, tabB], activeBySpace: { "/p": "/s/a" } },
        viewedPathRef: { current: "/s/a" },
      });
      executionsByCwd["/p"] = exec("/s/a", state);
      const before = JSON.stringify(executionsByCwd);
      const out = performCloseTab(deps, "/s/a");
      expect(out.removed).toBe(true);
      // Owner stays owned even though its tab is gone.
      expect(JSON.stringify(executionsByCwd)).toBe(before);
      expect(executionsByCwd["/p"]?.sessionFile).toBe("/s/a");
      neverTouchedRuntime(bridge, deps.viewSession, deps.showLanding);
    });
  }

  it("6: closing the selected tab with a same-Space sibling views the sibling; registry untouched", () => {
    const { deps, bridge, executionsByCwd } = makeDeps({
      navTabs: { tabs: [tabA, tabB], activeBySpace: { "/p": "/s/a" } },
      viewedPathRef: { current: "/s/a" },
    });
    executionsByCwd["/p"] = exec("/s/b", "working");
    const out = performCloseTab(deps, "/s/a");
    expect(out).toEqual({ removed: true, navigated: true });
    expect(deps.viewSession).toHaveBeenCalledWith("/s/b", "/p");
    expect(deps.showLanding).not.toHaveBeenCalled();
    expect(executionsByCwd["/p"]?.sessionFile).toBe("/s/b");
    neverTouchedRuntime(bridge, deps.viewSession, deps.showLanding);
  });

  it("7: closing the selected last tab lands (Space preserved by view-landing); registry untouched", () => {
    const { deps, bridge, executionsByCwd } = makeDeps({
      navTabs: { tabs: [tabA], activeBySpace: { "/p": "/s/a" } },
      viewedPathRef: { current: "/s/a" },
    });
    executionsByCwd["/p"] = exec("/s/a", "working");
    const out = performCloseTab(deps, "/s/a");
    expect(out).toEqual({ removed: true, navigated: true });
    expect(deps.viewSession).not.toHaveBeenCalled();
    expect(deps.showLanding).toHaveBeenCalledTimes(1);
    // activeSpace lives outside this transition (showLanding is view-only,
    // commit 3); nothing here can clear it.
    expect(executionsByCwd["/p"]?.sessionFile).toBe("/s/a");
    neverTouchedRuntime(bridge, deps.viewSession, deps.showLanding);
  });

  it("8: closing the selected tab while a DIFFERENT hidden session executes navigates only", () => {
    const { deps, bridge, executionsByCwd } = makeDeps({
      navTabs: { tabs: [tabA], activeBySpace: { "/p": "/s/a" } },
      viewedPathRef: { current: "/s/a" },
      sessionByPath: new Map([["/p/pinned", { cwd: "/p" }]]),
      pinnedOrder: ["/p/pinned"],
    });
    const hiddenOwner = { ...exec("/elsewhere/x", "working"), cwd: "/elsewhere" };
    executionsByCwd["/elsewhere"] = hiddenOwner;
    performCloseTab(deps, "/s/a");
    // Same-Space pinned is preferred over landing when present.
    expect(deps.viewSession).toHaveBeenCalledWith("/p/pinned", "/p");
    expect(executionsByCwd["/elsewhere"]).toBe(hiddenOwner);
    neverTouchedRuntime(bridge, deps.viewSession, deps.showLanding);
  });

  it("9: closing the execution tab while B is viewed leaves B viewed (no navigation)", () => {
    // A holds execution (maybe working), B is on screen.
    const { deps, bridge, executionsByCwd } = makeDeps({
      navTabs: { tabs: [tabA, tabB], activeBySpace: { "/p": "/s/b" } },
      viewedPathRef: { current: "/s/b" },
    });
    executionsByCwd["/p"] = exec("/s/a", "working");
    const out = performCloseTab(deps, "/s/a");
    expect(out).toEqual({ removed: true, navigated: false });
    expect(deps.viewedPathRef.current).toBe("/s/b");
    expect(deps.viewSession).not.toHaveBeenCalled();
    expect(deps.showLanding).not.toHaveBeenCalled();
    expect(executionsByCwd["/p"]?.sessionFile).toBe("/s/a");
    neverTouchedRuntime(bridge, deps.viewSession, deps.showLanding);
  });

  it("closing an absent path is a no-op", () => {
    const { deps } = makeDeps({ navTabs: { tabs: [tabA], activeBySpace: {} } });
    expect(performCloseTab(deps, "/s/missing")).toEqual({ removed: false, navigated: false });
    expect(deps.setNavTabs).not.toHaveBeenCalled();
  });
});

describe("31: closed execution tab + Return to live reopens it (commits 3+5+6)", () => {
  it("viewSession re-registers the tab and selects it; ownership never changes", () => {
    const owner = exec("/s/a", "working");
    const tabB = { path: "/s/b", cwd: "/p" };
    const { deps, bridge, executionsByCwd } = makeDeps({
      navTabs: { tabs: [{ path: "/s/a", cwd: "/p" }, tabB], activeBySpace: { "/p": "/s/b" } },
      viewedPathRef: { current: "/s/b" },
    });
    executionsByCwd["/p"] = owner;
    const tabsAfterClose: { path: string; cwd: string }[] = [tabB];

    // Close A (execution holder) while B is viewed: navigation-only.
    expect(performCloseTab(deps, "/s/a")).toEqual({ removed: true, navigated: false });
    expect(tabsAfterClose.some((t) => t.path === "/s/a")).toBe(false);
    expect(executionsByCwd["/p"]).toBe(owner);

    // Return to live: viewSession only — its real implementation registers
    // the tab (registerOpenSession), which this stand-in mirrors.
    const viewSession = vi.fn((path: string, cwd: string) => {
      if (!tabsAfterClose.some((t) => t.path === path)) tabsAfterClose.push({ path, cwd });
      deps.viewedPathRef.current = path;
    });
    expect(
      returnToExecution({
        currentExecution: executionsByCwd["/p"],
        viewSession,
        bridge,
        onBeforeView: () => undefined,
      })
    ).toBe(true);
    expect(viewSession).toHaveBeenCalledWith("/s/a", "/p");
    // A is back in the working set and viewed; ownership identical; no runtime API.
    expect(tabsAfterClose.some((t) => t.path === "/s/a")).toBe(true);
    expect(deps.viewedPathRef.current).toBe("/s/a");
    expect(executionsByCwd["/p"]).toBe(owner);
    neverTouchedRuntime(bridge, viewSession, () => undefined);
  });
});
