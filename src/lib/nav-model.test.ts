import { describe, expect, it } from "vitest";
import type { SessionRuntimeState } from "../sessionRuntime";
import {
  addNavTab,
  agentStateLabel,
  closeNavTab,
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

describe("addNavTab / closeNavTab", () => {
  it("adds without reordering and never deletes the session", () => {
    const tabs = addNavTab([{ path: "a", cwd: "/x" }], "/x", "b");
    expect(tabs).toEqual([
      { path: "a", cwd: "/x" },
      { path: "b", cwd: "/x" },
    ]);
    // Re-adding keeps position (activation is separate from order).
    expect(addNavTab(tabs, "/x", "a")).toBe(tabs);
    const closed = closeNavTab(tabs, "a");
    expect(closed.tabs).toEqual([{ path: "b", cwd: "/x" }]);
    expect(closed.fallback).toEqual({ path: "b", cwd: "/x" });
  });

  it("falls back to the neighbor, then to landing", () => {
    const tabs = [
      { path: "a", cwd: "/x" },
      { path: "b", cwd: "/y" },
      { path: "c", cwd: "/x" },
    ];
    expect(closeNavTab(tabs, "b").fallback).toEqual({ path: "c", cwd: "/x" });
    expect(closeNavTab([{ path: "a", cwd: "/x" }], "a").fallback).toBeNull();
    expect(closeNavTab(tabs, "missing").fallback).toBeNull();
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
