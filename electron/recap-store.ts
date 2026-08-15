import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { type Recap } from "./recap";

/** Babylon-owned recap annotations, keyed by session file path. Kept out of
 *  the append-only session file so recaps never disturb Pi's ancestry or the
 *  session title lookup (getSessionName stops at the first session_info). */
interface RecapLedger {
  version: 1;
  byFile: Record<string, Recap[]>;
}

const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

function fileKey(sessionFile: string): string {
  return createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
}

export class RecapStore {
  private cache = new Map<string, Recap[]>();

  constructor(private readonly stateDir: string) {}

  private path(): string {
    return join(this.stateDir, "recaps.json");
  }

  private async load(): Promise<RecapLedger> {
    try {
      const target = this.path();
      const stat = await fsp.stat(target);
      if (stat.size > MAX_LEDGER_BYTES) return { version: 1, byFile: {} };
      const raw = await fsp.readFile(target, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.version !== 1 || typeof parsed.byFile !== "object") return { version: 1, byFile: {} };
      return parsed as RecapLedger;
    } catch {
      return { version: 1, byFile: {} };
    }
  }

  async recapsFor(sessionFile: string): Promise<Recap[]> {
    const key = fileKey(sessionFile);
    if (this.cache.has(key)) return this.cache.get(key)!;
    const ledger = await this.load();
    const recaps = ledger.byFile[key] ?? [];
    this.cache.set(key, recaps);
    return recaps;
  }

  async append(sessionFile: string, recap: Recap): Promise<void> {
    const key = fileKey(sessionFile);
    const ledger = await this.load();
    const list = ledger.byFile[key] ?? [];
    list.push(recap);
    ledger.byFile[key] = list;
    this.cache.set(key, list);
    await fsp.mkdir(this.stateDir, { recursive: true });
    await fsp.writeFile(this.path(), JSON.stringify(ledger), "utf8");
  }
}
