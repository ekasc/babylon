import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RollbackStore, entryDigest, missingCheckpointReason, type ActiveRollback, type TurnCheckpoint, type TurnReceipt } from "./rollback-store";

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

describe("turn receipts", () => {
  const receipt = (over: Partial<TurnReceipt> = {}): TurnReceipt => ({
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    userEntryId: "user-3",
    outcome: "failed",
    reason: "the post-turn snapshot failed",
    createdAt: new Date(0).toISOString(),
    ...over,
  });

  it("commits checkpoint and receipt in one write", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-rollback-"));
    roots.push(root);
    const store = new RollbackStore(root);
    const checkpoint: TurnCheckpoint = {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      userEntryId: "user-3",
      parentLeafId: null,
      finalLeafId: "assistant-3",
      beforeTree: "a".repeat(40),
      afterTree: "b".repeat(40),
      changedPaths: [],
      complete: true,
      exclusions: [],
      createdAt: new Date(0).toISOString(),
    };
    await store.recordTurnOutcome({
      checkpoint,
      receipt: receipt({ outcome: "checkpointed", reason: "checkpoint recorded" }),
    });
    const ledger = await store.load("session-1");
    expect(ledger.checkpoints).toEqual([checkpoint]);
    expect(ledger.receipts?.map((r) => r.outcome)).toEqual(["checkpointed"]);
  });

  it("replaces the receipt on retry and keeps unknown turns on the legacy message", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-rollback-"));
    roots.push(root);
    const store = new RollbackStore(root);
    await store.recordTurnOutcome({ receipt: receipt() });
    await store.recordTurnOutcome({ receipt: receipt({ outcome: "skipped", reason: "shares the active turn" }) });
    const ledger = await store.load("session-1");
    expect(ledger.receipts?.length).toBe(1);
    expect(ledger.receipts?.[0]?.outcome).toBe("skipped");
    expect(missingCheckpointReason(ledger.receipts, "user-3")).toBe("No checkpoint for this turn: shares the active turn");
    expect(missingCheckpointReason(ledger.receipts, "user-9")).toBe("No filesystem checkpoint was recorded for this turn");
    expect(missingCheckpointReason(undefined, "user-3")).toBe("No filesystem checkpoint was recorded for this turn");
  });

  it("explains failed captures with their cause", () => {
    expect(missingCheckpointReason([receipt()], "user-3")).toBe(
      "Checkpoint capture failed for this turn: the post-turn snapshot failed"
    );
  });
});

describe("sqlite ledger", () => {
  const checkpoint = (id: string): TurnCheckpoint => ({
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    userEntryId: id,
    parentLeafId: null,
    finalLeafId: `${id}-a`,
    beforeTree: "a".repeat(40),
    afterTree: "b".repeat(40),
    changedPaths: [],
    complete: true,
    exclusions: [],
    createdAt: new Date(0).toISOString(),
  });

  it("imports a legacy JSON ledger once, verifying counts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-rollback-"));
    roots.push(root);
    const { createHash } = await import("node:crypto");
    const { writeFile } = await import("node:fs/promises");
    const legacy = join(root, `${createHash("sha256").update("session-1").digest("hex")}.json`);
    await writeFile(
      legacy,
      JSON.stringify({ version: 1, checkpoints: [checkpoint("user-3")], active: undefined })
    );
    const store = new RollbackStore(root);
    const ledger = await store.load("session-1");
    expect(ledger.checkpoints.map((c) => c.userEntryId)).toEqual(["user-3"]);
    // Imported and removed; a second load finds the rows, not the file.
    const { stat } = await import("node:fs/promises");
    await expect(stat(legacy)).rejects.toThrow();
    expect((await store.load("session-1")).checkpoints.length).toBe(1);
    store.close();
  });

  it("caps history at the newest entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-rollback-"));
    roots.push(root);
    const store = new RollbackStore(root);
    for (let i = 0; i < 2001; i++) await store.addCheckpoint(checkpoint(`user-${i}`));
    const ledger = await store.load("session-1");
    expect(ledger.checkpoints.length).toBe(2000);
    expect(ledger.checkpoints[1999]?.userEntryId).toBe("user-2000");
    expect(ledger.checkpoints[0]?.userEntryId).toBe("user-1");
    store.close();
  });

  it("backs up pre-existing state daily and keeps the journal in WAL mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-rollback-"));
    roots.push(root);
    const first = new RollbackStore(root);
    await first.addCheckpoint(checkpoint("user-3"));
    first.close();
    const day = new Date().toISOString().slice(0, 10);
    const second = new RollbackStore(root);
    const { stat } = await import("node:fs/promises");
    await expect(stat(join(root, "backups", `state-${day}.sqlite`))).resolves.toBeDefined();
    expect((await second.load("session-1")).checkpoints.length).toBe(1);
    second.close();
    const { DatabaseSync } = await import("node:sqlite");
    const probe = new DatabaseSync(join(root, "state.sqlite"));
    expect((probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    probe.close();
  });
});
