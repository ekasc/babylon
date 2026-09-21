import { createHash } from "node:crypto";
import { existsSync, mkdirSync, promises as fsp } from "node:fs";
import { join } from "node:path";
import { isArrayOf, isString, wireOf, wireStr } from "../src/store";
import { DatabaseSync } from "node:sqlite";

export interface TurnCheckpoint {
  sessionId: string;
  sessionFile: string;
  userEntryId: string;
  parentLeafId: string | null;
  finalLeafId: string;
  beforeTree: string;
  afterTree: string;
  changedPaths: string[];
  complete: boolean;
  exclusions: string[];
  createdAt: string;
}

export interface ActiveRollback {
  version: 1;
  sessionId: string;
  sessionFile: string;
  targetUserEntryId: string;
  rollbackLeafId: string | null;
  previousLeafId: string;
  entryDigest: string;
  redoTree: string;
  restoreMap: Record<string, string>;
  restoredPaths: string[];
  abandonedUserEntryIds: string[];
  editorText: string;
  createdAt: string;
  state: "active";
}

export type TurnOutcome = "checkpointed" | "skipped" | "failed";

// What happened when a turn ended, committed in the same transaction as its
// checkpoint (or instead of one). Readers use it to explain a missing
// checkpoint: a steer message shares its turn by design, while a failed
// capture names its cause. Without this every case reads identically and a
// broken capture only surfaces later, far from its cause.
export interface TurnReceipt {
  sessionId: string;
  sessionFile: string;
  userEntryId: string;
  outcome: TurnOutcome;
  reason: string;
  createdAt: string;
}

export interface Ledger {
  version: 1;
  checkpoints: TurnCheckpoint[];
  receipts?: TurnReceipt[];
  active?: ActiveRollback;
}

function badLedger(what: string): Error {
  return new Error(`corrupt rollback ledger: invalid ${what}`);
}

function reqStr(wire: Record<string, unknown>, key: string): string {
  const v = wire[key];
  if (typeof v !== "string") throw badLedger(key);
  return v;
}

function optStr(wire: Record<string, unknown>, key: string): string | null | undefined {
  const v = wire[key];
  if (v === undefined || v === null) return v ?? undefined;
  if (typeof v !== "string") throw badLedger(key);
  return v;
}

function reqStrArr(wire: Record<string, unknown>, key: string): string[] {
  const v = wire[key];
  if (!isArrayOf(v, isString)) throw badLedger(key);
  return v;
}

/** Validate one ledger checkpoint (all fields required). */
function toTurnCheckpoint(value: unknown): TurnCheckpoint {
  const w = wireOf(value);
  if (!w) throw badLedger("checkpoint");
  return {
    sessionId: reqStr(w, "sessionId"),
    sessionFile: reqStr(w, "sessionFile"),
    userEntryId: reqStr(w, "userEntryId"),
    parentLeafId: optStr(w, "parentLeafId") ?? null,
    finalLeafId: reqStr(w, "finalLeafId"),
    beforeTree: reqStr(w, "beforeTree"),
    afterTree: reqStr(w, "afterTree"),
    changedPaths: reqStrArr(w, "changedPaths"),
    complete: w.complete === true,
    exclusions: reqStrArr(w, "exclusions"),
    createdAt: reqStr(w, "createdAt"),
  };
}

/** Validate one ledger receipt. */
function toTurnReceipt(value: unknown): TurnReceipt {
  const w = wireOf(value);
  if (!w) throw badLedger("receipt");
  const outcome = w.outcome;
  if (outcome !== "checkpointed" && outcome !== "skipped" && outcome !== "failed") throw badLedger("receipt outcome");
  return {
    sessionId: reqStr(w, "sessionId"),
    sessionFile: reqStr(w, "sessionFile"),
    userEntryId: reqStr(w, "userEntryId"),
    outcome,
    reason: reqStr(w, "reason"),
    createdAt: reqStr(w, "createdAt"),
  };
}

/** Validate the in-progress rollback record. */
function toActiveRollback(value: unknown): ActiveRollback {
  const w = wireOf(value);
  if (!w) throw badLedger("active rollback");
  if (w.version !== 1) throw badLedger("active rollback version");
  if (w.state !== "active") throw badLedger("active rollback state");
  const restoreMapRaw = w.restoreMap;
  if (typeof restoreMapRaw !== "object" || restoreMapRaw === null || Array.isArray(restoreMapRaw)) {
    throw badLedger("active rollback restoreMap");
  }
  const restoreMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(restoreMapRaw)) {
    if (typeof v !== "string") throw badLedger("active rollback restoreMap");
    restoreMap[k] = v;
  }
  const strArr = (key: string): string[] => {
    const v = w[key];
    if (!isArrayOf(v, isString)) throw badLedger(key);
    return v;
  };
  return {
    version: 1,
    sessionId: reqStr(w, "sessionId"),
    sessionFile: reqStr(w, "sessionFile"),
    targetUserEntryId: reqStr(w, "targetUserEntryId"),
    rollbackLeafId: optStr(w, "rollbackLeafId") ?? null,
    previousLeafId: reqStr(w, "previousLeafId"),
    entryDigest: reqStr(w, "entryDigest"),
    redoTree: reqStr(w, "redoTree"),
    restoreMap,
    restoredPaths: strArr("restoredPaths"),
    abandonedUserEntryIds: strArr("abandonedUserEntryIds"),
    editorText: reqStr(w, "editorText"),
    createdAt: reqStr(w, "createdAt"),
    state: "active",
  };
}

export function entryDigest(entries: Array<{ id?: unknown; parentId?: unknown; type?: unknown }>): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(String(entry.id ?? ""));
    hash.update("\0");
    hash.update(String(entry.parentId ?? ""));
    hash.update("\0");
    hash.update(String(entry.type ?? ""));
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** Why a turn has no usable checkpoint, for error messages. Total: unknown
 *  turns keep the legacy message. */
export function missingCheckpointReason(receipts: TurnReceipt[] | undefined, userEntryId: string): string {
  const receipt = receipts?.find((item) => item.userEntryId === userEntryId);
  if (!receipt) return "No filesystem checkpoint was recorded for this turn";
  if (receipt.outcome === "skipped") return `No checkpoint for this turn: ${receipt.reason}`;
  return `Checkpoint capture failed for this turn: ${receipt.reason}`;
}

function fileKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

const HISTORY_CAP = 2000;
const BACKUP_KEEP = 3;

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS rollback_checkpoints (
      session_id TEXT NOT NULL,
      user_entry_id TEXT NOT NULL,
      session_file TEXT NOT NULL,
      parent_leaf_id TEXT,
      final_leaf_id TEXT NOT NULL,
      before_tree TEXT NOT NULL,
      after_tree TEXT NOT NULL,
      changed_paths_json TEXT NOT NULL DEFAULT '[]',
      complete INTEGER NOT NULL DEFAULT 1,
      exclusions_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, user_entry_id)
    );
    CREATE TABLE IF NOT EXISTS turn_receipts (
      session_id TEXT NOT NULL,
      user_entry_id TEXT NOT NULL,
      session_file TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, user_entry_id)
    );
    CREATE TABLE IF NOT EXISTS rollback_active (
      session_id TEXT PRIMARY KEY,
      session_file TEXT NOT NULL,
      target_user_entry_id TEXT NOT NULL,
      rollback_leaf_id TEXT,
      previous_leaf_id TEXT NOT NULL,
      entry_digest TEXT NOT NULL,
      redo_tree TEXT NOT NULL,
      restore_map_json TEXT NOT NULL,
      restored_paths_json TEXT NOT NULL,
      abandoned_ids_json TEXT NOT NULL,
      editor_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
  },
];

type CheckpointRow = {
  session_id: string;
  user_entry_id: string;
  session_file: string;
  parent_leaf_id: string | null;
  final_leaf_id: string;
  before_tree: string;
  after_tree: string;
  changed_paths_json: string;
  complete: number;
  exclusions_json: string;
  created_at: string;
};

type ReceiptRow = {
  session_id: string;
  user_entry_id: string;
  session_file: string;
  outcome: string;
  reason: string;
  created_at: string;
};

type ActiveRow = {
  session_id: string;
  session_file: string;
  target_user_entry_id: string;
  rollback_leaf_id: string | null;
  previous_leaf_id: string;
  entry_digest: string;
  redo_tree: string;
  restore_map_json: string;
  restored_paths_json: string;
  abandoned_ids_json: string;
  editor_text: string;
  created_at: string;
};

export class RollbackStore {
  private readonly db: DatabaseSync;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dbPath = join(dir, "state.sqlite");
    const existed = existsSync(dbPath);
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    // Back up pre-existing state only: a fresh database has nothing to lose,
    // and the legacy JSON beside it is the backup until it imports.
    if (existed) {
      try {
        this.maybeBackup();
      } catch (error) {
        console.warn("[pideck] rollback backup failed:", error instanceof Error ? error.message : error);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /** One write transaction. BEGIN IMMEDIATE takes the write lock up front so
   *  a concurrent writer blocks on the busy timeout instead of interleaving. */
  private atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let attempt = 0; attempt < 3; attempt++) {
      const applied = new Set(
        (this.db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
          (row) => row.version
        )
      );
      const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
      if (pending.length === 0) return;
      // One transaction per attempt; a concurrent migrator either blocks on
      // the write lock (busy timeout) and then finds nothing pending, or its
      // no-op DDL plus INSERT OR IGNORE converges below.
      this.atomic(() => {
        for (const m of pending) {
          this.db.exec(m.sql);
          this.db
            .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .run(m.version, new Date().toISOString());
        }
      });
      const now = new Set(
        (this.db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
          (row) => row.version
        )
      );
      if (pending.every((m) => now.has(m.version))) return;
    }
    throw new Error("rollback store migrations did not converge");
  }

  private maybeBackup(): void {
    const day = new Date().toISOString().slice(0, 10);
    const backupDir = join(this.dir, "backups");
    const dest = join(backupDir, `state-${day}.sqlite`);
    if (existsSync(dest)) return;
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    void fsp
      .readdir(backupDir)
      .then((names) => {
        const stale = names.filter((n) => n.startsWith("state-")).sort().slice(0, -BACKUP_KEEP);
        return Promise.all(stale.map((name) => fsp.rm(join(backupDir, name), { force: true }).catch(() => undefined)));
      })
      .catch(() => undefined);
  }

  /** Import a pre-SQLite ledger once, verifying counts before removing it. */
  private async importLegacy(sessionId: string): Promise<void> {
    const target = join(this.dir, `${fileKey(sessionId)}.json`);
    let raw: string;
    try {
      raw = await fsp.readFile(target, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw error;
    }
    const parsed = wireOf(JSON.parse(raw) as unknown);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.checkpoints)) {
      await fsp.rm(target, { force: true });
      return;
    }
    const receipts = Array.isArray(parsed.receipts) ? parsed.receipts : [];
    const checkpoints = Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [];
    // Same-writer ledger files (version-gated above), but the file is still
    // untrusted JSON: every item is validated before it enters the store, so
    // a corrupt ledger fails the import instead of poisoning queries.
    this.atomic(() => {
      for (const checkpoint of checkpoints) this.upsertCheckpoint(toTurnCheckpoint(checkpoint));
      for (const receipt of receipts) this.upsertReceipt(toTurnReceipt(receipt));
      const active = wireOf(parsed.active);
      if (active && wireStr(active, "sessionId") === sessionId) {
        this.upsertActive(toActiveRollback(active));
      }
    });
    const check = (this.db.prepare("SELECT COUNT(*) AS n FROM rollback_checkpoints WHERE session_id = ?").get(sessionId) as { n: number }).n;
    if (check !== parsed.checkpoints.length) throw new Error("legacy import count mismatch");
    await fsp.rm(target, { force: true });
  }

  async load(sessionId: string): Promise<Ledger> {
    await this.importLegacy(sessionId);
    const checkpoints = (
      this.db
        .prepare("SELECT * FROM rollback_checkpoints WHERE session_id = ? ORDER BY rowid")
        .all(sessionId) as CheckpointRow[]
    ).map(
      (row): TurnCheckpoint => ({
        sessionId: row.session_id,
        sessionFile: row.session_file,
        userEntryId: row.user_entry_id,
        parentLeafId: row.parent_leaf_id,
        finalLeafId: row.final_leaf_id,
        beforeTree: row.before_tree,
        afterTree: row.after_tree,
        changedPaths: JSON.parse(row.changed_paths_json) as string[],
        complete: row.complete !== 0,
        exclusions: JSON.parse(row.exclusions_json) as string[],
        createdAt: row.created_at,
      })
    );
    const receipts = (
      this.db.prepare("SELECT * FROM turn_receipts WHERE session_id = ? ORDER BY rowid").all(sessionId) as ReceiptRow[]
    ).map(
      (row): TurnReceipt => ({
        sessionId: row.session_id,
        sessionFile: row.session_file,
        userEntryId: row.user_entry_id,
        outcome: row.outcome as TurnOutcome,
        reason: row.reason,
        createdAt: row.created_at,
      })
    );
    const activeRow = this.db.prepare("SELECT * FROM rollback_active WHERE session_id = ?").get(sessionId) as
      | ActiveRow
      | undefined;
    const ledger: Ledger = { version: 1, checkpoints, receipts };
    if (activeRow) {
      ledger.active = {
        version: 1,
        sessionId: activeRow.session_id,
        sessionFile: activeRow.session_file,
        targetUserEntryId: activeRow.target_user_entry_id,
        rollbackLeafId: activeRow.rollback_leaf_id,
        previousLeafId: activeRow.previous_leaf_id,
        entryDigest: activeRow.entry_digest,
        redoTree: activeRow.redo_tree,
        restoreMap: JSON.parse(activeRow.restore_map_json) as Record<string, string>,
        restoredPaths: JSON.parse(activeRow.restored_paths_json) as string[],
        abandonedUserEntryIds: JSON.parse(activeRow.abandoned_ids_json) as string[],
        editorText: activeRow.editor_text,
        createdAt: activeRow.created_at,
        state: "active",
      };
    }
    return ledger;
  }

  private upsertCheckpoint(checkpoint: TurnCheckpoint): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO rollback_checkpoints
         (session_id, user_entry_id, session_file, parent_leaf_id, final_leaf_id, before_tree, after_tree, changed_paths_json, complete, exclusions_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        checkpoint.sessionId,
        checkpoint.userEntryId,
        checkpoint.sessionFile,
        checkpoint.parentLeafId,
        checkpoint.finalLeafId,
        checkpoint.beforeTree,
        checkpoint.afterTree,
        JSON.stringify(checkpoint.changedPaths),
        checkpoint.complete ? 1 : 0,
        JSON.stringify(checkpoint.exclusions),
        checkpoint.createdAt
      );
    this.db
      .prepare(
        `DELETE FROM rollback_checkpoints WHERE session_id = ? AND rowid NOT IN
         (SELECT rowid FROM rollback_checkpoints WHERE session_id = ? ORDER BY rowid DESC LIMIT ${HISTORY_CAP})`
      )
      .run(checkpoint.sessionId, checkpoint.sessionId);
  }

  private upsertReceipt(receipt: TurnReceipt): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO turn_receipts (session_id, user_entry_id, session_file, outcome, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(receipt.sessionId, receipt.userEntryId, receipt.sessionFile, receipt.outcome, receipt.reason, receipt.createdAt);
    this.db
      .prepare(
        `DELETE FROM turn_receipts WHERE session_id = ? AND rowid NOT IN
         (SELECT rowid FROM turn_receipts WHERE session_id = ? ORDER BY rowid DESC LIMIT ${HISTORY_CAP})`
      )
      .run(receipt.sessionId, receipt.sessionId);
  }

  private upsertActive(active: ActiveRollback): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO rollback_active
         (session_id, session_file, target_user_entry_id, rollback_leaf_id, previous_leaf_id, entry_digest, redo_tree, restore_map_json, restored_paths_json, abandoned_ids_json, editor_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        active.sessionId,
        active.sessionFile,
        active.targetUserEntryId,
        active.rollbackLeafId,
        active.previousLeafId,
        active.entryDigest,
        active.redoTree,
        JSON.stringify(active.restoreMap),
        JSON.stringify(active.restoredPaths),
        JSON.stringify(active.abandonedUserEntryIds),
        active.editorText,
        active.createdAt
      );
  }

  async addCheckpoint(checkpoint: TurnCheckpoint): Promise<void> {
    this.atomic(() => this.upsertCheckpoint(checkpoint));
  }

  /** Commit a turn's checkpoint and its receipt in one transaction, so the two
   *  can never diverge: a turn either has both or the receipt says why not. */
  async recordTurnOutcome(outcome: { checkpoint?: TurnCheckpoint; receipt: TurnReceipt }): Promise<void> {
    this.atomic(() => {
      if (outcome.checkpoint) this.upsertCheckpoint(outcome.checkpoint);
      this.upsertReceipt(outcome.receipt);
    });
  }

  async setActive(sessionId: string, active: ActiveRollback): Promise<void> {
    this.atomic(() => this.upsertActive(active));
  }

  async clearActive(sessionId: string): Promise<void> {
    this.db.prepare("DELETE FROM rollback_active WHERE session_id = ?").run(sessionId);
  }
}
