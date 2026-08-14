import { describe, expect, it } from "vitest";
import type { CommandInfo, ProjectGroup, SessionMeta } from "./bridge";
import { buildPaletteIndex, searchPalette } from "./paletteSearch";

function session(id: string, name: string | undefined, cwd: string, mtime: number, firstUserText?: string): SessionMeta {
  return { id, path: `/sessions/${id}`, cwd, name, mtime, firstUserText };
}

const commands: CommandInfo[] = [
  { name: "workflows", description: "run a workflow", source: "extension" },
  { name: "compact", description: "compact the conversation", source: "extension" },
  { name: "skills", description: "list skills", source: "skill" },
];

describe("palette search", () => {
  it("lists recent sessions and commands first when the query is empty", () => {
    const groups: ProjectGroup[] = [
      { cwd: "/tmp/a", sessions: [session("s-old", "Old project", "/tmp/a", 100)] },
      { cwd: "/tmp/b", sessions: [session("s-new", "Fresh work", "/tmp/b", 500)] },
    ];
    const results = searchPalette(buildPaletteIndex(groups, commands), "");
    expect(results[0]).toEqual({ type: "new", key: "new" });
    const sessions = results.filter((r) => r.type === "session");
    expect(sessions.map((r) => r.key)).toEqual(["/sessions/s-new", "/sessions/s-old"]);
    expect(results.filter((r) => r.type === "command").length).toBeGreaterThan(0);
  });

  it("matches sessions by name, first user text, or project path, case-insensitively", () => {
    const groups: ProjectGroup[] = [
      { cwd: "/home/dev/linear", sessions: [session("s1", "Auth refactor", "/home/dev/linear", 100, "fix the login flow")] },
      { cwd: "/home/dev/other", sessions: [session("s2", "Untitled", "/home/dev/other", 200)] },
    ];
    const byName = searchPalette(buildPaletteIndex(groups, commands), "AUTH");
    expect(byName.some((r) => r.type === "session" && r.key === "/sessions/s1")).toBe(true);
    const byText = searchPalette(buildPaletteIndex(groups, commands), "login");
    expect(byText.some((r) => r.type === "session" && r.key === "/sessions/s1")).toBe(true);
    const byPath = searchPalette(buildPaletteIndex(groups, commands), "linear");
    expect(byPath.some((r) => r.type === "session" && r.key === "/sessions/s1")).toBe(true);
    const noMatch = searchPalette(buildPaletteIndex(groups, commands), "zzz-nope");
    expect(noMatch.some((r) => r.type === "session")).toBe(false);
  });

  it("caps session results and keeps command ranking", () => {
    const groups: ProjectGroup[] = [
      { cwd: "/p", sessions: Array.from({ length: 40 }, (_, i) => session(`s${i}`, `Session ${i}`, "/p", 1000 - i)) },
    ];
    const withQuery = searchPalette(buildPaletteIndex(groups, commands), "session");
    expect(withQuery.filter((r) => r.type === "session").length).toBe(20);
    const empty = searchPalette(buildPaletteIndex(groups, commands), "");
    expect(empty.filter((r) => r.type === "session").length).toBe(8);
    const workflow = searchPalette(buildPaletteIndex(groups, commands), "work");
    const ranked = workflow.filter((r) => r.type === "command").map((r) => r.command.name);
    expect(ranked[0]).toBe("workflows");
  });

  it("stays fast with thousands of sessions", () => {
    const groups: ProjectGroup[] = [
      {
        cwd: "/work",
        sessions: Array.from({ length: 3000 }, (_, i) =>
          session(`s${i}`, `Project ${i % 97} refactor`, "/work", 1_000_000_000 - i, "handle the edge cases")
        ),
      },
    ];
    const index = buildPaletteIndex(groups, commands);
    const queries = ["", "ref", "edge", "project 42", "auth", "case", "workflows", "compact"];
    const start = performance.now();
    for (let round = 0; round < 30; round++) {
      for (const query of queries) searchPalette(index, query);
    }
    const elapsed = performance.now() - start;
    // 240 searches over 3000 sessions must not approach a frame budget.
    expect(elapsed).toBeLessThan(300);
  });
});
