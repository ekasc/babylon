// Snapcompact archive persistence.
//
// Stores per-session archives as immutable generations under
// Babylon-owned state:
//
//   <stateDir>/snapcompact/<sessionKey>/
//     manifest.json          - points at the active generation
//     generations/
//       <generation-id>/
//         frame-0000.png
//
// Crash safety and branch addressability:
//   - Each generation is written into a fresh directory under
//     generations/, frame files first, manifest only after the
//     frame set is complete and validated. The manifest is swapped
//     atomically (rename(2)). A crash before the swap leaves the
//     previous generation byte-for-byte loadable.
//   - Generations are immutable once written. Navigating back to an
//     older Pi branch (which has an older CompactionEntry) can still
//     load its generation via loadGeneration(sessionFile, genId) even
//     after the active manifest has moved forward.
//   - GC is reference-aware: it never deletes a generation still
//     referenced by any reachable SessionEntry (compaction entry).
//     Callers that know the reachable set pass it; otherwise GC keeps
//     a bounded window.

import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { SnapcompactArchive, SnapcompactFrame, SnapcompactSymbol } from "./types";

const MANIFEST_VERSION = 1;
const GENERATION_PREFIX = "gen-";
const MAX_GENERATIONS_KEPT = 8;

function sessionKey(sessionFile: string): string {
  return createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
}

function archiveDir(stateDir: string, key: string): string {
  return join(stateDir, "snapcompact", key);
}

function manifestPath(stateDir: string, key: string): string {
  return join(archiveDir(stateDir, key), "manifest.json");
}

function manifestTmpPath(stateDir: string, key: string): string {
  return join(archiveDir(stateDir, key), "manifest.json.tmp");
}

function generationsDir(stateDir: string, key: string): string {
  return join(archiveDir(stateDir, key), "generations");
}

function generationDir(stateDir: string, key: string, genId: string): string {
  return join(generationsDir(stateDir, key), genId);
}

function generationStagingDir(stateDir: string, key: string, genId: string): string {
  return join(generationsDir(stateDir, key), genId + ".staging-" + randomUUID().slice(0, 8));
}

export class ArchiveIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveIntegrityError";
  }
}

interface PersistedFrameMeta {
  index: number;
  width: number;
  height: number;
  sourceOffset: number;
  sourceEnd: number;
  file: string;
}

interface PersistedGeneration {
  id: string;
  createdAt: number;
  frameWidth: number;
  frameHeight: number;
  profileId: string;
  frames: PersistedFrameMeta[];
}

interface PersistedArchive {
  version: 1;
  sessionId: string;
  sessionFile: string;
  strategy: "snapcompact";
  sourceText: string;
  symbols: SnapcompactSymbol[];
  generation: PersistedGeneration;
  coveredThroughMessageId: string | null;
  coveredThroughTimestamp: number | null;
  frameBytes: number;
  compactionGenerationId?: string;
  firstKeptEntryId?: string | null;
  lastKeptEntryId?: string | null;
  keptCount?: number;
  omittedTrailing?: Array<{ entryId: string; role: string; reason: string }>;
}

async function readJson(path: string): Promise<unknown> {
  const raw = await fsp.readFile(path, "utf8");
  return JSON.parse(raw);
}

async function atomicWriteJson(target: string, tmp: string, value: unknown): Promise<void> {
  await fsp.mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, target);
}

export interface ArchiveStoreOptions {
  stateDir: string;
}

export class ArchiveStore {
  private cache = new Map<string, SnapcompactArchive | null>();
  // Generation-level cache: sessionKey -> generationId -> archive
  private genCache = new Map<string, Map<string, SnapcompactArchive | null>>();

  constructor(private readonly opts: ArchiveStoreOptions) {}

  private keyFor(sessionFile: string): string {
    return sessionKey(sessionFile);
  }

  private async loadFromPersisted(raw: PersistedArchive): Promise<SnapcompactArchive> {
    const k = this.keyFor(raw.sessionFile);
    const gen = raw.generation;
    const gdir = generationDir(this.opts.stateDir, k, gen.id);
    const frames: SnapcompactFrame[] = [];
    try {
      for (const meta of gen.frames) {
        const fp = join(gdir, meta.file);
        const buf = await fsp.readFile(fp);
        frames.push({ index: meta.index, width: meta.width, height: meta.height, png: buf, sourceOffset: meta.sourceOffset, sourceEnd: meta.sourceEnd });
      }
    } catch (err: any) {
      throw new ArchiveIntegrityError(`snapcompact archive frame file missing: ${err?.message ?? String(err)}`);
    }
    return {
      version: MANIFEST_VERSION,
      sessionId: raw.sessionId,
      sessionFile: raw.sessionFile,
      strategy: raw.strategy,
      sourceText: raw.sourceText,
      symbols: raw.symbols,
      frames,
      coveredThroughMessageId: raw.coveredThroughMessageId,
      createdAt: gen.createdAt,
      coveredThroughTimestamp: raw.coveredThroughTimestamp,
      frameWidth: gen.frameWidth,
      frameHeight: gen.frameHeight,
      profileId: gen.profileId,
      frameBytes: raw.frameBytes,
      compactionGenerationId: raw.compactionGenerationId ?? gen.id,
      firstKeptEntryId: raw.firstKeptEntryId ?? raw.coveredThroughMessageId,
      lastKeptEntryId: raw.lastKeptEntryId ?? raw.coveredThroughMessageId,
      keptCount: raw.keptCount ?? frames.length,
      omittedTrailing: raw.omittedTrailing ?? [],
    };
  }

  /** Read the active manifest and load the referenced generation. */
  async load(sessionFile: string): Promise<SnapcompactArchive | null> {
    const k = this.keyFor(sessionFile);
    if (this.cache.has(k)) return this.cache.get(k) ?? null;
    const mpath = manifestPath(this.opts.stateDir, k);
    let raw: PersistedArchive;
    try {
      const parsed = (await readJson(mpath)) as PersistedArchive;
      if (parsed?.version !== MANIFEST_VERSION) return null;
      if (!parsed.generation || !Array.isArray(parsed.generation.frames)) return null;
      raw = parsed;
    } catch {
      return null;
    }
    try {
      const archive = await this.loadFromPersisted(raw);
      this.cache.set(k, archive);
      // Also populate gen cache
      const gmap = this.genCache.get(k) ?? new Map();
      gmap.set(archive.compactionGenerationId, archive);
      this.genCache.set(k, gmap);
      return archive;
    } catch (err: any) {
      if (err instanceof ArchiveIntegrityError) {
        this.cache.set(k, null);
        throw err;
      }
      throw err;
    }
  }

  private dirIdFor(generationId: string): string {
    return generationId.startsWith(GENERATION_PREFIX) ? generationId : GENERATION_PREFIX + generationId;
  }

  /** Load a specific generation by compactionGenerationId, even if it is
   *  no longer the active manifest. Returns null if the generation
   *  directory does not exist or cannot be fully reconstructed.
   *  Uses a per-generation manifest snapshot stored alongside frames
   *  (generation.json) so older generations remain loadable after the
   *  active manifest moves forward. */
  async loadGeneration(sessionFile: string, generationId: string): Promise<SnapcompactArchive | null> {
    const k = this.keyFor(sessionFile);
    const gmap = this.genCache.get(k);
    if (gmap?.has(generationId)) return gmap.get(generationId) ?? null;
    // Accept both raw uuid and gen- prefixed form
    const dirId = this.dirIdFor(generationId);
    if (gmap?.has(dirId)) return gmap.get(dirId) ?? null;
    const gdir = generationDir(this.opts.stateDir, k, dirId);
    const genManifest = join(gdir, "generation.json");
    let raw: PersistedArchive;
    try {
      raw = (await readJson(genManifest)) as PersistedArchive;
    } catch {
      // Fallback: if active manifest points at this generation, use it
      const mpath = manifestPath(this.opts.stateDir, k);
      try {
        const parsed = (await readJson(mpath)) as PersistedArchive;
        if (parsed?.version === MANIFEST_VERSION && (parsed.compactionGenerationId === generationId || parsed.generation?.id === generationId || parsed.generation?.id === dirId)) {
          raw = parsed;
        } else {
          return null;
        }
      } catch {
        return null;
      }
    }
    if (raw.version !== MANIFEST_VERSION) return null;
    try {
      const archive = await this.loadFromPersisted(raw);
      const map2 = this.genCache.get(k) ?? new Map();
      map2.set(generationId, archive);
      this.genCache.set(k, map2);
      return archive;
    } catch (err: any) {
      if (err instanceof ArchiveIntegrityError) {
        const map2 = this.genCache.get(k) ?? new Map();
        map2.set(generationId, null);
        this.genCache.set(k, map2);
        throw err;
      }
      throw err;
    }
  }

  async listGenerations(sessionFile: string): Promise<string[]> {
    const k = this.keyFor(sessionFile);
    const gdirRoot = generationsDir(this.opts.stateDir, k);
    try {
      const entries = await fsp.readdir(gdirRoot, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && e.name.startsWith(GENERATION_PREFIX)).map((e) => e.name);
    } catch { return []; }
  }

  /** Atomically replace the archive for `sessionFile`. */
  async write(sessionFile: string, archive: Omit<SnapcompactArchive, "version" | "frameBytes">, opts?: { referencedGenerationIds?: Set<string> }): Promise<SnapcompactArchive> {
    const k = this.keyFor(sessionFile);
    const gdirRoot = generationsDir(this.opts.stateDir, k);
    await fsp.mkdir(gdirRoot, { recursive: true, mode: 0o700 });

    const newGenId = archive.compactionGenerationId;
    // Ensure generation dir name matches compactionGenerationId for
    // branch switching. If the id doesn't already look like a gen-
    // prefixed id, prefix it.
    const dirId = newGenId.startsWith(GENERATION_PREFIX) ? newGenId : GENERATION_PREFIX + newGenId;
    const staging = generationStagingDir(this.opts.stateDir, k, dirId);
    await fsp.mkdir(staging, { recursive: true, mode: 0o700 });

    const frameMetas: PersistedFrameMeta[] = [];
    let frameBytes = 0;
    try {
      for (const f of archive.frames) {
        const fileName = `frame-${String(f.index).padStart(4, "0")}.png`;
        const staged = join(staging, fileName);
        await fsp.writeFile(staged, f.png, { mode: 0o600 });
        frameBytes += f.png.length;
        frameMetas.push({ index: f.index, width: f.width, height: f.height, sourceOffset: f.sourceOffset, sourceEnd: f.sourceEnd, file: fileName });
      }
      for (const meta of frameMetas) {
        await fsp.access(join(staging, meta.file));
      }
      const finalGenDir = generationDir(this.opts.stateDir, k, dirId);
      // Remove any existing dir with same id (idempotent retry)
      await fsp.rm(finalGenDir, { recursive: true, force: true }).catch(() => undefined);
      await fsp.rename(staging, finalGenDir);

      const generation: PersistedGeneration = {
        id: dirId,
        createdAt: archive.createdAt,
        frameWidth: archive.frameWidth,
        frameHeight: archive.frameHeight,
        profileId: archive.profileId,
        frames: frameMetas,
      };
      const persisted: PersistedArchive = {
        version: MANIFEST_VERSION,
        sessionId: archive.sessionId,
        sessionFile: archive.sessionFile,
        strategy: archive.strategy,
        sourceText: archive.sourceText,
        symbols: archive.symbols,
        generation,
        coveredThroughMessageId: archive.coveredThroughMessageId,
        coveredThroughTimestamp: archive.coveredThroughTimestamp,
        frameBytes,
        compactionGenerationId: archive.compactionGenerationId,
        firstKeptEntryId: archive.firstKeptEntryId,
        lastKeptEntryId: archive.lastKeptEntryId,
        keptCount: archive.keptCount,
        omittedTrailing: archive.omittedTrailing,
      };
      // Also write a per-generation snapshot so loadGeneration can
      // reconstruct older branches without the active manifest.
      await fsp.writeFile(join(finalGenDir, "generation.json"), JSON.stringify(persisted, null, 2), { mode: 0o600 });
      await atomicWriteJson(manifestPath(this.opts.stateDir, k), manifestTmpPath(this.opts.stateDir, k), persisted);

      await this.gcGenerations(k, dirId, opts?.referencedGenerationIds);

      const fullArchive: SnapcompactArchive = { version: MANIFEST_VERSION, ...archive, frameBytes };
      this.cache.set(k, fullArchive);
      const gmap = this.genCache.get(k) ?? new Map();
      gmap.set(archive.compactionGenerationId, fullArchive);
      // Also map by dirId for listGenerations lookup
      gmap.set(dirId, fullArchive);
      this.genCache.set(k, gmap);
      return fullArchive;
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async gcGenerations(k: string, keep: string, referenced?: Set<string>): Promise<void> {
    const gdirRoot = generationsDir(this.opts.stateDir, k);
    let entries: { name: string }[];
    try { entries = (await fsp.readdir(gdirRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => ({ name: e.name })); }
    catch { return; }
    const realGens = entries.map((e) => e.name).filter((n) => n.startsWith(GENERATION_PREFIX));
    if (realGens.length <= MAX_GENERATIONS_KEPT) return;
    realGens.sort();
    // Build set of ids that must never be deleted (still referenced)
    const protectedIds = new Set<string>();
    protectedIds.add(keep);
    protectedIds.add(this.dirIdFor(keep));
    if (referenced) {
      for (const r of referenced) {
        protectedIds.add(r);
        protectedIds.add(this.dirIdFor(r));
      }
    }
    const removable = realGens.filter((n) => !protectedIds.has(n));
    if (!removable.length) return;
    const keepNonRefCount = Math.max(0, MAX_GENERATIONS_KEPT - protectedIds.size);
    // Keep newest keepNonRefCount among removable, delete the rest (oldest)
    const toDelete = removable.slice(0, Math.max(0, removable.length - keepNonRefCount));
    for (const name of toDelete) {
      await fsp.rm(join(gdirRoot, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async clear(sessionFile: string): Promise<void> {
    const k = this.keyFor(sessionFile);
    const adir = archiveDir(this.opts.stateDir, k);
    await fsp.rm(adir, { recursive: true, force: true });
    this.cache.delete(k);
    this.genCache.delete(k);
  }

  async exists(sessionFile: string): Promise<boolean> {
    const a = await this.load(sessionFile);
    return a !== null;
  }
}
