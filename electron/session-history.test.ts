import { describe, expect, it } from "vitest";
import { projectHistory } from "./session-history";
import type { SessionTreeRow } from "./session-tree";
import type { TurnCheckpoint } from "./rollback-store";

function row(id: string, parentId: string | null, role: "user" | "assistant", snippet: string): SessionTreeRow {
  return { id, parentId, type: "message", role, snippet, depth: 0, childCount: 0 };
}

function checkpoint(userEntryId: string): TurnCheckpoint {
  return {
    sessionId: "session",
    sessionFile: "/session.jsonl",
    userEntryId,
    parentLeafId: null,
    finalLeafId: `${userEntryId}-a`,
    beforeTree: "a".repeat(40),
    afterTree: "b".repeat(40),
    changedPaths: ["src/file.ts"],
    complete: true,
    exclusions: [],
    createdAt: new Date(0).toISOString(),
  };
}

describe("projectHistory", () => {
  it("renders a linear conversation as turns without branch depth", () => {
    const rows = [row("u1", null, "user", "one"), row("a1", "u1", "assistant", "reply"), row("u2", "a1", "user", "two"), row("a2", "u2", "assistant", "reply two")];
    const history = projectHistory({ rows, leafId: "a2", checkpoints: [checkpoint("u1"), checkpoint("u2")], gitAvailable: true, streaming: false });
    expect(history.hasBranches).toBe(false);
    expect(history.turns.map((turn) => ({ text: turn.text, depth: turn.depth, available: turn.rollbackAvailable }))).toEqual([
      { text: "one", depth: 0, available: true },
      { text: "two", depth: 1, available: true },
    ]);
  });

  it("marks real user-turn divergence and rejects abandoned-path rollback", () => {
    const rows = [
      row("u1", null, "user", "one"),
      row("a1", "u1", "assistant", "reply"),
      row("u2", "a1", "user", "active"),
      row("a2", "u2", "assistant", "active reply"),
      row("u2b", "a1", "user", "abandoned"),
      row("a2b", "u2b", "assistant", "old reply"),
    ];
    const history = projectHistory({ rows, leafId: "a2", checkpoints: [checkpoint("u1"), checkpoint("u2"), checkpoint("u2b")], gitAvailable: true, streaming: false });
    expect(history.hasBranches).toBe(true);
    expect(history.turns.find((turn) => turn.entryId === "u1")?.branchCount).toBe(2);
    expect(history.turns.find((turn) => turn.entryId === "u2b")).toMatchObject({ onActivePath: false, rollbackAvailable: false, rollbackReason: "This turn is not on the active path" });
  });
});
