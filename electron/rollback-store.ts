import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";

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

interface Ledger {
  version: 1;
  checkpoints: TurnCheckpoint[];
  active?: ActiveRollback;
}

function fileKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
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

export class RollbackStore {
  constructor(private readonly stateDir: string) {}

  private path(sessionId: string): string {
    return join(this.stateDir, `${fileKey(sessionId)}.json`);
  }

  async load(sessionId: string): Promise<Ledger> {
    try {
      const target = this.path(sessionId);
      const stat = await fsp.stat(target);
      if (stat.size > 32 * 1024 * 1024) throw new Error("rollback ledger exceeds the size limit");
      const raw = await fsp.readFile(target, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.version !== 1 || !Array.isArray(parsed.checkpoints)) throw new Error("invalid rollback ledger");
      return parsed as Ledger;
    } catch (error: any) {
      if (error?.code === "ENOENT") return { version: 1, checkpoints: [] };
      throw error;
    }
  }

  private async write(sessionId: string, ledger: Ledger): Promise<void> {
    const target = this.path(sessionId);
    await fsp.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temp, target);
  }

  async addCheckpoint(checkpoint: TurnCheckpoint): Promise<void> {
    const ledger = await this.load(checkpoint.sessionId);
    const checkpoints = ledger.checkpoints.filter((item) => item.userEntryId !== checkpoint.userEntryId);
    checkpoints.push(checkpoint);
    // Bound renderer-independent metadata growth while retaining substantial history.
    ledger.checkpoints = checkpoints.slice(-2000);
    await this.write(checkpoint.sessionId, ledger);
  }

  async setActive(sessionId: string, active: ActiveRollback): Promise<void> {
    const ledger = await this.load(sessionId);
    ledger.active = active;
    await this.write(sessionId, ledger);
  }

  async clearActive(sessionId: string): Promise<void> {
    const ledger = await this.load(sessionId);
    if (!ledger.active) return;
    delete ledger.active;
    await this.write(sessionId, ledger);
  }
}
