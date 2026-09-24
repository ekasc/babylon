import { describe, expect, it } from "vitest";
import type { SessionRuntimeState } from "../sessionRuntime";
import {
  addNavTab,
  agentStateLabel,
  closeSpaceTab,
  deriveLiveAgents,
  migrateLegacyTabs,
  pickSpaceTab,
  tabsStore,
  visibleSpaceTabs,
} from "./nav-model";

function rt(over: Partial<SessionRuntimeState> & { sessionPath: string; cwd: string }): SessionRuntimeState {
  return {
    sessionId: "s",
    lifecycle: "open",
    execution: "idle",
    attention: "none",
    live: false,
    ...over,
  };
}

describe("migrateLegacyTabs", () => {
  it("flattens the per-space record in space order", () => {
    const out = migrateLegacyTabs({ "/b": ["p2"], "/a": ["p1"] }, ["/a", "/b"]);
    expect(out.tabs).toEqual([
      { path: "p1", cwd: "/a" },
      { path: "p2", cwd: "/b" },
    ]);
    expect(out.activeBySpace).toEqual({});
  });

  it("dedupes paths and passes v2 blobs through", () => {
    const v2 = { tabs: [{ path: "p1", cwd: "/a" }], activeBySpace: { "/a": "p1" } };
    expect(migrateLegacyTabs(v2, [])).toEqual(v2);
    expect(migrateLegacyTabs({ "/a": ["p1", "p1"] }, []).tabs).toEqual([{ path: "p1", cwd: "/a" }]);
  });
});

describe("tabsStore", () => {
  it("accepts stamped v2 blobs and migrates legacy records", () => {
    expect(tabsStore.validate({ tabs: [{ path: "p", cwd: "/a" }], activeBySpace: {} })).toBe(true);
    expect(tabsStore.validate({ tabs: [{ path: "p" }] })).toBe(false);
    expect(tabsStore.validate({ tabs: [], activeBySpace: { "/a": 42 } })).toBe(false);
    expect(tabsStore.validate(null)).toBe(false);
    expect(tabsStore.migrate?.({ "/a": ["p1"] }, 0)).toEqual({ tabs: [{ path: "p1", cwd: "/a" }], activeBySpace: {} });
    const v2 = { tabs: [{ path: "p1", cwd: "/a" }], activeBySpace: {} };
    expect(tabsStore.migrate?.(v2, 0)).toEqual(v2);
  });
});

describe("addNavTab / closeSpaceTab", () => {
  const A = { path: "A", cwd: "/a" };
  const make = (path: string, cwd: string) => ({ path, cwd });

  it("adds without reordering and never deletes the session", () => {
    const tabs = addNavTab([{ path: "a", cwd: "/x" }], "/x", "b");
    expect(tabs).toEqual([
      { path: "a", cwd: "/x" },
      { path: "b", cwd: "/x" },
    ]);
    // Re-adding keeps position (activation is separate from order).
    expect(addNavTab(tabs, "/x", "a")).toBe(tabs);
  });

  // Spec 28: same-Space fallback + atomic, Space-scoped activeBySpace.
  it("1: closing a middle tab prefers the right neighbor", () => {
    const r = closeSpaceTab({ tabs: [make("A1", "/a"), make("A2", "/a"), make("A3", "/a")], activeBySpace: {} }, "A2");
    expect(r.closed).toEqual(make("A2", "/a"));
    expect(r.fallback).toEqual(make("A3", "/a"));
    expect(r.state.tabs.map((t) => t.path)).toEqual(["A1", "A3"]);
  });

  it("2: closing the last tab falls back to the left neighbor", () => {
    const r = closeSpaceTab({ tabs: [make("A1", "/a"), make("A2", "/a")], activeBySpace: {} }, "A2");
    expect(r.fallback).toEqual(make("A1", "/a"));
  });

  it("3: closing the only tab falls back to null", () => {
    const r = closeSpaceTab({ tabs: [A], activeBySpace: {} }, "A");
    expect(r.fallback).toBeNull();
    expect(r.state.tabs).toEqual([]);
  });

  it("4: interleaved global order — fallback is same-Space only, never a B tab", () => {
    const state = {
      tabs: [make("A1", "/a"), make("B1", "/b"), make("A2", "/a"), make("B2", "/b"), make("A3", "/a")],
      activeBySpace: {},
    };
    const r = closeSpaceTab(state, "A2");
    expect(r.fallback).toEqual(make("A3", "/a"));
    expect(r.fallback?.cwd).toBe("/a");
    // Global insertion order of survivors is preserved.
    expect(r.state.tabs.map((t) => t.path)).toEqual(["A1", "B1", "B2", "A3"]);
  });

  it("5: closing a non-remembered tab leaves activeBySpace untouched", () => {
    const r = closeSpaceTab({ tabs: [make("A1", "/a"), make("A2", "/a")], activeBySpace: { "/a": "A1" } }, "A2");
    expect(r.state.activeBySpace).toEqual({ "/a": "A1" });
  });

  it("6: closing the remembered viewed tab repairs activeBySpace to the fallback", () => {
    const r = closeSpaceTab({ tabs: [make("A1", "/a"), make("A2", "/a")], activeBySpace: { "/a": "A2" } }, "A2");
    expect(r.state.activeBySpace).toEqual({ "/a": "A1" });
  });

  it("7: closing the last remembered tab removes the key (no dead path)", () => {
    const r = closeSpaceTab({ tabs: [A], activeBySpace: { "/a": "A" } }, "A");
    expect(r.state.activeBySpace).toEqual({});
    expect("/a" in r.state.activeBySpace).toBe(false);
  });

  it("8: closing an A tab leaves Space B's remembered entry byte-for-byte unchanged", () => {
    const before = { "/a": "A1", "/b": "B9" };
    const r = closeSpaceTab(
      { tabs: [make("A1", "/a"), make("A2", "/a"), make("B9", "/b")], activeBySpace: { ...before } },
      "A2"
    );
    expect(r.state.activeBySpace["/b"]).toBe("B9");
    expect(r.state.activeBySpace).toEqual({ "/a": "A1", "/b": "B9" });
  });

  it("closing a missing path is a no-op", () => {
    const state = { tabs: [A], activeBySpace: {} };
    const r = closeSpaceTab(state, "missing");
    expect(r.closed).toBeNull();
    expect(r.fallback).toBeNull();
    expect(r.state).toBe(state);
  });
});
describe("pickSpaceTab", () => {
  const tabs = [
    { path: "a", cwd: "/x" },
    { path: "b", cwd: "/y" },
  ];
  it("prefers the remembered tab when still open", () => {
    expect(pickSpaceTab(tabs, { "/x": "a" }, "/x")).toEqual({ path: "a", cwd: "/x" });
  });
  it("falls back to an open tab, else null (landing, no auto-create)", () => {
    expect(pickSpaceTab(tabs, {}, "/y")).toEqual({ path: "b", cwd: "/y" });
    expect(pickSpaceTab(tabs, { "/y": "gone" }, "/y")).toEqual({ path: "b", cwd: "/y" });
    expect(pickSpaceTab(tabs, {}, "/z")).toBeNull();
  });
});

describe("visibleSpaceTabs", () => {
  const tabs = [
    { path: "a", cwd: "/x" },
    { path: "b", cwd: "/y" },
    { path: "c", cwd: "/x" },
  ];
  it("shows only the active project's tabs", () => {
    expect(visibleSpaceTabs(tabs, "/x")).toEqual([
      { path: "a", cwd: "/x" },
      { path: "c", cwd: "/x" },
    ]);
    expect(visibleSpaceTabs(tabs, "/y")).toEqual([{ path: "b", cwd: "/y" }]);
    expect(visibleSpaceTabs(tabs, "/z")).toEqual([]);
  });
  it("falls back to everything with no project context", () => {
    expect(visibleSpaceTabs(tabs, null)).toBe(tabs);
  });
});

describe("deriveLiveAgents", () => {
  const mtime = new Map([["w", 3], ["a", 2], ["u", 1]]);
  const runtime = [
    rt({ sessionPath: "w", cwd: "/x", execution: "working", live: true }),
    rt({ sessionPath: "a", cwd: "/x", execution: "approval", live: true }),
    rt({ sessionPath: "i", cwd: "/x" }),
    rt({ sessionPath: "f", cwd: "/x", execution: "failed", live: true }),
    rt({ sessionPath: "u", cwd: "/y", attention: "unread" }),
    rt({ sessionPath: "s", cwd: "/x", execution: "failed", lifecycle: "settled" }),
  ];
  it("shows only chats with a running turn (working/waiting/approval)", () => {
    const paths = deriveLiveAgents(runtime, mtime).map((a) => a.path);
    expect(paths).toContain("w");
    expect(paths).toContain("a");
    expect(paths).not.toContain("i");
    expect(paths).not.toContain("f");
    expect(paths).not.toContain("u");
    expect(paths).not.toContain("s");
  });

  it("orders approval before working", () => {
    const agents = deriveLiveAgents(
      [
        rt({ sessionPath: "f", cwd: "/x", execution: "working", live: true }),
        rt({ sessionPath: "a", cwd: "/x", execution: "approval", live: true }),
        rt({ sessionPath: "w", cwd: "/x", execution: "working", live: true }),
      ],
      new Map([["w", 2], ["f", 1]])
    ).map((a) => a.path);
    expect(agents).toEqual(["a", "w", "f"]);
  });
});

describe("agentStateLabel", () => {
  it("names states the way the section shows them", () => {
    expect(agentStateLabel({ execution: "working", attention: "none" })).toBe("Working");
    expect(agentStateLabel({ execution: "waiting", attention: "none" })).toBe("Waiting");
    expect(agentStateLabel({ execution: "idle", attention: "approval" })).toBe("Needs input");
    expect(agentStateLabel({ execution: "failed", attention: "none" })).toBe("Failed");
    expect(agentStateLabel({ execution: "idle", attention: "unread" })).toBe("Unread");
  });
});
