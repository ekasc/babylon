import { describe, expect, it } from "vitest";
import {
  buildAllSpaceCwds,
  buildAttentionByPath,
  buildHistoryEntries,
  buildSessionByPath,
  buildTabItems,
  resolveSessionTitle,
} from "./app-selectors";
import { assembleRuntimeState } from "./sessionRuntime";
import type { ProjectGroup } from "./bridge";

const groups: ProjectGroup[] = [
  {
    cwd: "/work/alpha",
    sessions: [
      { id: "aaaaaaaa", path: "/s/a.json", cwd: "/work/alpha", name: "Alpha chat", mtime: 100 },
      { id: "bbbbbbbb", path: "/s/b.json", cwd: "/work/alpha", firstUserText: "first words", mtime: 300 },
    ],
  },
  {
    cwd: "/work/beta",
    sessions: [{ id: "cccccccc", path: "/s/c.json", cwd: "/work/beta", mtime: 200 }],
  },
];

describe("app-selectors", () => {
  it("builds a path map with each session's project cwd", () => {
    const map = buildSessionByPath(groups);
    expect(map.size).toBe(3);
    expect(map.get("/s/a.json")?.cwd).toBe("/work/alpha");
    expect(map.get("/s/c.json")?.session.id).toBe("cccccccc");
  });

  it("resolves titles by name, first text, id, then basename", () => {
    const map = buildSessionByPath(groups);
    expect(resolveSessionTitle(map, "/s/a.json")).toBe("Alpha chat");
    expect(resolveSessionTitle(map, "/s/b.json")).toBe("first words");
    expect(resolveSessionTitle(map, "/s/c.json")).toBe("cccccccc");
    expect(resolveSessionTitle(map, "/missing/x.json")).toBe("x.json");
  });

  it("builds tab items only for tabs with a known session", () => {
    const map = buildSessionByPath(groups);
    const titleFor = (p: string) => resolveSessionTitle(map, p);
    expect(buildTabItems([{ path: "/s/a.json" }, { path: "/nope" }], map, titleFor)).toEqual([
      { path: "/s/a.json", cwd: "/work/alpha", title: "Alpha chat" },
    ]);
  });

  it("builds history entries newest-first with open flags", () => {
    const entries = buildHistoryEntries(groups, new Set(["/s/a.json"]));
    expect(entries.map((e) => e.path)).toEqual(["/s/b.json", "/s/c.json", "/s/a.json"]);
    expect(entries.find((e) => e.path === "/s/a.json")?.open).toBe(true);
    expect(entries.find((e) => e.path === "/s/b.json")?.projectName).toBe("alpha");
  });

  it("derives attention per path", () => {
    const runtime = {
      "/s/a.json": assembleRuntimeState({
        sessionId: "aaaaaaaa",
        sessionPath: "/s/a.json",
        cwd: "/work/alpha",
        lifecycle: "open",
        execution: "idle",
        attention: "unread",
      }),
    };
    expect(buildAttentionByPath(runtime).get("/s/a.json")).toBe("unread");
  });

  it("includes the active space in the cwd list even when unknown", () => {
    expect(buildAllSpaceCwds(["/a"], "/b")).toEqual(["/a", "/b"]);
    expect(buildAllSpaceCwds(["/a", "/b"], "/a")).toEqual(["/a", "/b"]);
    expect(buildAllSpaceCwds(["/a"], null)).toEqual(["/a"]);
  });

});
