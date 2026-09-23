import { describe, expect, it } from "vitest";
import { projectHistory } from "./session-history";
import type { SessionTreeRow } from "./session-tree";
import type { TurnCheckpoint } from "./rollback-store";

function row(id: string, parentId: string | null, role: "user" | "assistant", snippet: string): SessionTreeRow {
  return { id, parentId, type: "message", role, snippet, depth: 0, childCount: 0 };
}

function anyRow(id: string, parentId: string | null, type: string, role: string | undefined, snippet: string): SessionTreeRow {
  return { id, parentId, type, role, snippet, depth: 0, childCount: 0 };
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

  it("tracks parent users and depth through tool/custom rows between turns", () => {
    // Deep linear chain: user turns separated by tool calls, thinking
    // blocks, and custom entries. Interleaved rows must not disturb the
    // user-ancestor chain or the depth count.
    const rows = [
      row("u1", null, "user", "one"),
      anyRow("t1", "u1", "tool", "tool", "bash output"),
      row("a1", "t1", "assistant", "reply"),
      anyRow("c1", "a1", "custom", "custom", "extension note"),
      row("u2", "c1", "user", "two"),
      anyRow("t2", "u2", "tool", "tool", "more output"),
      anyRow("t3", "t2", "tool", "tool", "even more"),
      row("a2", "t3", "assistant", "reply two"),
      row("u3", "a2", "user", "three"),
      row("a3", "u3", "assistant", "reply three"),
    ];
    const history = projectHistory({ rows, leafId: "a3", checkpoints: [checkpoint("u1"), checkpoint("u2"), checkpoint("u3")], gitAvailable: true, streaming: false });
    expect(history.turns.map((turn) => ({ id: turn.entryId, parent: turn.parentUserEntryId, depth: turn.depth, response: turn.response }))).toEqual([
      { id: "u1", parent: null, depth: 0, response: "" },
      { id: "u2", parent: "u1", depth: 1, response: "" },
      { id: "u3", parent: "u2", depth: 2, response: "reply three" },
    ]);
  });

  it("keeps branch counts, active path, and current turn on forks", () => {
    const rows = [
      row("u1", null, "user", "one"),
      row("a1", "u1", "assistant", "reply"),
      row("u2", "a1", "user", "active"),
      row("a2", "u2", "assistant", "active reply"),
      row("u2b", "a1", "user", "abandoned"),
      row("a2b", "u2b", "assistant", "old reply"),
      row("u3", "a2", "user", "third"),
      row("a3", "u3", "assistant", "third reply"),
    ];
    const history = projectHistory({ rows, leafId: "a3", checkpoints: [checkpoint("u1"), checkpoint("u2"), checkpoint("u2b"), checkpoint("u3")], gitAvailable: true, streaming: false });
    expect(history.hasBranches).toBe(true);
    expect(history.turns.map((turn) => turn.entryId)).toEqual(["u1", "u2", "u2b", "u3"]);
    expect(history.turns.find((turn) => turn.entryId === "u1")).toMatchObject({ branchCount: 2, depth: 0, parentUserEntryId: null });
    expect(history.turns.find((turn) => turn.entryId === "u2")).toMatchObject({ parentUserEntryId: "u1", depth: 1, onActivePath: true });
    expect(history.turns.find((turn) => turn.entryId === "u3")).toMatchObject({ parentUserEntryId: "u2", depth: 2, onActivePath: true, current: true });
    expect(history.turns.find((turn) => turn.entryId === "u2b")).toMatchObject({ parentUserEntryId: "u1", depth: 1, onActivePath: false, current: false });
  });

  it("lets the first assistant child in row order win the response", () => {
    const rows = [
      row("u1", null, "user", "one"),
      row("a1", "u1", "assistant", "first reply"),
      anyRow("t1", "u1", "tool", "tool", "late tool result"),
      row("a2", "u1", "assistant", "second reply"),
    ];
    const history = projectHistory({ rows, leafId: "a2", checkpoints: [checkpoint("u1")], gitAvailable: true, streaming: false });
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0]?.response).toBe("first reply");
  });

  it("treats non-message user-role rows as ancestry boundaries without making them turns", () => {    // A custom entry carrying role "user" (agent-authored attribution, fork
    // metadata): the old walk treats it as a user boundary for parent/depth
    // purposes while only type "message" users become turns.
    const rows = [
      row("u1", null, "user", "one"),
      row("a1", "u1", "assistant", "reply"),
      anyRow("cu", "a1", "custom", "user", "attribution note"),
      row("u2", "cu", "user", "two"),
      row("a2", "u2", "assistant", "reply two"),
    ];
    const history = projectHistory({ rows, leafId: "a2", checkpoints: [checkpoint("u1"), checkpoint("u2")], gitAvailable: true, streaming: false });
    expect(history.turns.map((turn) => turn.entryId)).toEqual(["u1", "u2"]);
    expect(history.turns.find((turn) => turn.entryId === "u2")).toMatchObject({ parentUserEntryId: "cu", depth: 2 });
  });

  it("matches the legacy nested-scan projection on randomized trees", () => {
    // Reference implementation: the pre-optimization algorithm, kept here
    // (not imported) so any semantic drift in the linear rewrite fails loudly.
    const legacyRaw = (rows: SessionTreeRow[]) => {
      const byId = new Map(rows.map((r) => [r.id, r]));
      return rows
        .filter((r) => r.type === "message" && r.role === "user")
        .map((r) => {
          let parent = r.parentId ? byId.get(r.parentId) : undefined;
          while (parent && parent.role !== "user") parent = parent.parentId ? byId.get(parent.parentId) : undefined;
          let depth = 0;
          let ancestor = parent;
          while (ancestor) {
            depth++;
            let next = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
            while (next && next.role !== "user") next = next.parentId ? byId.get(next.parentId) : undefined;
            ancestor = next;
          }
          const response = rows.find((c) => c.parentId === r.id && c.role === "assistant")?.snippet ?? "";
          return { id: r.id, parentUserEntryId: parent?.id ?? null, depth, response };
        });
    };
    // Deterministic PRNG (mulberry32) so failures reproduce exactly.
    let seed = 0x9e3779b9;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const types = ["message", "message", "message", "tool", "custom", "thinking"];
    const roles = ["user", "assistant", "assistant", "tool", "custom", undefined];
    for (let trial = 0; trial < 200; trial++) {
      const count = 5 + Math.floor(rand() * 40);
      const rows: SessionTreeRow[] = [];
      for (let i = 0; i < count; i++) {
        // Preorder: every parent precedes its children.
        const parentId = i === 0 || rand() < 0.25 ? null : rows[Math.floor(rand() * rows.length)]!.id;
        rows.push({
          id: `n${trial}-${i}`,
          parentId,
          type: types[Math.floor(rand() * types.length)]!,
          role: roles[Math.floor(rand() * roles.length)],
          snippet: `s${i}`,
          depth: 0,
          childCount: 0,
        });
      }
      const leafId = rows[rows.length - 1]!.id;
      const history = projectHistory({ rows, leafId, checkpoints: [], gitAvailable: true, streaming: false });
      const actual = history.turns.map((t) => ({ id: t.entryId, parentUserEntryId: t.parentUserEntryId, depth: t.depth, response: t.response, onActivePath: t.onActivePath, current: t.current, branchCount: t.branchCount }));
      const expected = legacyRaw(rows).map((r) => {
        const path = new Set<string>();
        let c: SessionTreeRow | undefined = byIdOf(rows).get(leafId);
        while (c && !path.has(c.id)) {
          path.add(c.id);
          c = c.parentId ? byIdOf(rows).get(c.parentId) : undefined;
        }
        return { ...r, onActivePath: path.has(r.id), current: currentOf(rows, leafId) === r.id, branchCount: branchCountOf(rows, r.id) };
      });
      expect(actual, `trial ${trial}`).toEqual(expected);
    }

    function byIdOf(rows: SessionTreeRow[]): Map<string, SessionTreeRow> {
      return new Map(rows.map((r) => [r.id, r]));
    }
    function currentOf(rows: SessionTreeRow[], leafId: string): string | undefined {
      const byId = byIdOf(rows);
      let c = byId.get(leafId);
      while (c && c.role !== "user") c = c.parentId ? byId.get(c.parentId) : undefined;
      return c?.id;
    }
    function branchCountOf(rows: SessionTreeRow[], id: string): number {
      const byId = byIdOf(rows);
      let count = 0;
      for (const r of rows) {
        if (r.type !== "message" || r.role !== "user") continue;
        let p = r.parentId ? byId.get(r.parentId) : undefined;
        while (p && p.role !== "user") p = p.parentId ? byId.get(p.parentId) : undefined;
        if (p?.id === id) count++;
      }
      return count;
    }
  });
});
