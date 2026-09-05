import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { Handoff } from "../src/handoff";

/** Handoffs are sidecar-only, never transcript records, so pi's CLI never
 *  sees handoff machinery. Shape lives in `src/handoff.ts` (renderer-safe). */
interface HandoffLedger {
  version: 1;
  byFile: Record<string, Handoff[]>;
}

const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

function fileKey(sourceFile: string): string {
  return createHash("sha256").update(sourceFile).digest("hex").slice(0, 24);
}

export class HandoffStore {
  private cache = new Map<string, Handoff[]>();

  constructor(private readonly stateDir: string) {}

  private path(): string {
    return join(this.stateDir, "handoffs.json");
  }

  private async load(): Promise<HandoffLedger> {
    try {
      const target = this.path();
      const stat = await fsp.stat(target);
      if (stat.size > MAX_LEDGER_BYTES) return { version: 1, byFile: {} };
      const parsed = JSON.parse(await fsp.readFile(target, "utf8"));
      if (parsed?.version !== 1 || typeof parsed.byFile !== "object") return { version: 1, byFile: {} };
      return parsed as HandoffLedger;
    } catch {
      return { version: 1, byFile: {} };
    }
  }

  async forSource(sourceFile: string): Promise<Handoff[]> {
    const key = fileKey(sourceFile);
    const cached = this.cache.get(key);
    if (cached) return cached.map((h) => ({ ...h, consumedInto: [...h.consumedInto] }));
    const ledger = await this.load();
    const list = ledger.byFile[key] ?? [];
    this.cache.set(key, list);
    return list.map((h) => ({ ...h, consumedInto: [...h.consumedInto] }));
  }

  async findById(id: string): Promise<Handoff | undefined> {
    const ledger = await this.load();
    for (const list of Object.values(ledger.byFile)) {
      const found = list.find((h) => h.id === id);
      if (found) return { ...found, consumedInto: [...found.consumedInto] };
    }
    return undefined;
  }

  async append(sourceFile: string, init: Pick<Handoff, "summary" | "author" | "sourceChars">): Promise<Handoff> {
    const handoff: Handoff = {
      id: randomUUID(),
      sourceFile,
      at: new Date().toISOString(),
      consumedInto: [],
      ...init,
    };
    const key = fileKey(sourceFile);
    const ledger = await this.load();
    const list = [...(ledger.byFile[key] ?? []), handoff];
    ledger.byFile[key] = list;
    this.cache.set(key, list);
    await fsp.mkdir(this.stateDir, { recursive: true });
    await fsp.writeFile(this.path(), JSON.stringify(ledger), "utf8");
    return { ...handoff, consumedInto: [] };
  }

  async markConsumed(id: string, file: string): Promise<Handoff | undefined> {
    const ledger = await this.load();
    for (const [key, list] of Object.entries(ledger.byFile)) {
      const idx = list.findIndex((h) => h.id === id);
      if (idx < 0) continue;
      const current = list[idx]!;
      const next: Handoff = {
        ...current,
        consumedInto: [...current.consumedInto, { file, at: new Date().toISOString() }],
      };
      const nextList = [...list];
      nextList[idx] = next;
      ledger.byFile[key] = nextList;
      this.cache.set(key, nextList);
      await fsp.writeFile(this.path(), JSON.stringify(ledger), "utf8");
      return { ...next, consumedInto: [...next.consumedInto] };
    }
    return undefined;
  }
}
