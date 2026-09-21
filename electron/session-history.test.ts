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

  it("hides bookkeeping-only turns from the files-changed count", () => {
    const rows = [row("u1", null, "user", "one"), row("a1", "u1", "assistant", "reply")];
    const onlyLogs = { ...checkpoint("u1"), changedPaths: [".pi/state/guardrails/decisions.jsonl"] };
    const history = projectHistory({ rows, leafId: "a1", checkpoints: [onlyLogs], gitAvailable: true, streaming: false });
    expect(history.turns[0]?.changedCount).toBe(0);
    const mixed = { ...checkpoint("u1"), changedPaths: [".pi/state/guardrails/decisions.jsonl", "src/file.ts"] };
    const mixedHistory = projectHistory({ rows, leafId: "a1", checkpoints: [mixed], gitAvailable: true, streaming: false });
    expect(mixedHistory.turns[0]?.changedCount).toBe(1);
  });

  it("explains a missing checkpoint from its receipt, and keeps the legacy message without one", () => {
    const rows = [row("u1", null, "user", "one"), row("a1", "u1", "assistant", "reply")];
    const legacy = projectHistory({ rows, leafId: "a1", checkpoints: [], gitAvailable: true, streaming: false });
    expect(legacy.turns[0]?.rollbackReason).toBe("No filesystem checkpoint was recorded for this turn");
    const explained = projectHistory({
      rows,
      leafId: "a1",
      checkpoints: [],
      receipts: [
        {
          sessionId: "session",
          sessionFile: "/session.jsonl",
          userEntryId: "u1",
          outcome: "failed",
          reason: "the post-turn snapshot failed",
          createdAt: new Date(0).toISOString(),
        },
      ],
      gitAvailable: true,
      streaming: false,
    });
    expect(explained.turns[0]?.rollbackReason).toBe("Checkpoint capture failed for this turn: the post-turn snapshot failed");
  });
});
