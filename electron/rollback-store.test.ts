import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RollbackStore, entryDigest, type ActiveRollback, type TurnCheckpoint } from "./rollback-store";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("RollbackStore", () => {
  it("persists checkpoints and active undo state across instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-rollback-"));
    roots.push(root);
    const checkpoint: TurnCheckpoint = {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      userEntryId: "user-3",
      parentLeafId: "assistant-2",
      finalLeafId: "assistant-3",
      beforeTree: "a".repeat(40),
      afterTree: "b".repeat(40),
      changedPaths: ["src/app.ts"],
      complete: true,
      exclusions: [],
      createdAt: new Date(0).toISOString(),
    };
    const active: ActiveRollback = {
      version: 1,
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      targetUserEntryId: "user-3",
      rollbackLeafId: "assistant-2",
      previousLeafId: "assistant-5",
      entryDigest: entryDigest([{ id: "user-3", parentId: "assistant-2", type: "message" }]),
      redoTree: "c".repeat(40),
      restoreMap: { "src/app.ts": "a".repeat(40) },
      restoredPaths: ["src/app.ts"],
      abandonedUserEntryIds: ["user-3", "user-4", "user-5"],
      editorText: "third prompt",
      createdAt: new Date(1).toISOString(),
      state: "active",
    };

    const first = new RollbackStore(root);
    await first.addCheckpoint(checkpoint);
    await first.setActive("session-1", active);

    const reopened = await new RollbackStore(root).load("session-1");
    expect(reopened.checkpoints).toEqual([checkpoint]);
    expect(reopened.active).toEqual(active);

    await new RollbackStore(root).clearActive("session-1");
    expect((await first.load("session-1")).active).toBeUndefined();
  });
});
