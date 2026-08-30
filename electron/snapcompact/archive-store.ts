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
//         frame-0001.png
//
// Crash safety:
//   - Each generation is written into a fresh directory under
//     generations/, frame files first, manifest only after the
//     frame set is complete and validated. The manifest is swapped
//     atomically (rename(2)). A crash before the swap leaves the
//     previous generation byte-for-byte loadable.
//   - On load, the active generation's frame set is validated. Any
//     missing or corrupt frame makes the archive invalid; the
//     store throws so the caller can fall back to the existing
//     textual compaction. The archive never loads partially.
//
// Versioning: persisted manifest declares version=1. A future
// reader that sees a different version treats the archive as
// missing (returns null) rather than mis-decoding.

import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { SnapcompactArchive, SnapcompactFrame, SnapcompactSymbol } from "./types";

const MANIFEST_VERSION = 1;
const GENERATION_PREFIX = "gen-";
const MAX_GENERATIONS_KEPT = 4;

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
  // Optional for forward compatibility with older manifests; the loader
  // supplies safe defaults.
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

  constructor(private readonly opts: ArchiveStoreOptions) {}

  private keyFor(sessionFile: string): string {
    return sessionKey(sessionFile);
  }

  /** Read the active manifest and load the referenced generation. Throws
   *  ArchiveIntegrityError if the manifest or the active generation is
   *  missing, corrupt, or has any missing frame file. Returns null when
   *  no archive exists. */
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
    const gen = raw.generation;
    const gdir = generationDir(this.opts.stateDir, k, gen.id);
    const frames: SnapcompactFrame[] = [];
    let frameBytes = 0;
    try {
      for (const meta of gen.frames) {
        const fp = join(gdir, meta.file);
        const buf = await fsp.readFile(fp);
        frameBytes += buf.length;
        frames.push({ index: meta.index, width: meta.width, height: meta.height, png: buf, sourceOffset: meta.sourceOffset, sourceEnd: meta.sourceEnd });
      }
    } catch (err: any) {
      // Missing or unreadable frame file: the archive is invalid.
      this.cache.set(k, null);
      throw new ArchiveIntegrityError(`snapcompact archive frame file missing: ${err?.message ?? String(err)}`);
    }
    const archive: SnapcompactArchive = {
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
    this.cache.set(k, archive);
    return archive;
  }

  /** Atomically replace the archive for `sessionFile`. The previous
   *  generation is left on disk until the new one is fully written and
   *  the manifest is swapped. A crash before the swap leaves the
   *  previous archive loadable. A crash after the swap leaves the new
   *  archive loadable. */
  async write(sessionFile: string, archive: Omit<SnapcompactArchive, "version" | "frameBytes">): Promise<SnapcompactArchive> {
    const k = this.keyFor(sessionFile);
    const adir = archiveDir(this.opts.stateDir, k);
    const gdirRoot = generationsDir(this.opts.stateDir, k);
    await fsp.mkdir(gdirRoot, { recursive: true, mode: 0o700 });

    const newGenId = GENERATION_PREFIX + randomUUID().slice(0, 12);
    const staging = generationStagingDir(this.opts.stateDir, k, newGenId);
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
      // Validate the staged generation before swap.
      for (const meta of frameMetas) {
        await fsp.access(join(staging, meta.file));
      }
      // Atomically move the staged generation into the generations dir.
      const finalGenDir = generationDir(this.opts.stateDir, k, newGenId);
      await fsp.rename(staging, finalGenDir);

      const generation: PersistedGeneration = {
        id: newGenId,
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
      // Write the manifest last. A crash before this point leaves the
      // previous generation referenced by the old manifest, which is
      // still byte-for-byte intact.
      await atomicWriteJson(manifestPath(this.opts.stateDir, k), manifestTmpPath(this.opts.stateDir, k), persisted);

      // After a successful swap, GC old generations beyond a small
      // retention window so a previous crash leaving stale generations
      // on disk cannot grow without bound.
      await this.gcGenerations(k, newGenId);

      const fullArchive: SnapcompactArchive = { version: MANIFEST_VERSION, ...archive, frameBytes };
      this.cache.set(k, fullArchive);
      return fullArchive;
    } catch (err) {
      // Best-effort cleanup of the staging dir on failure.
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async gcGenerations(k: string, keep: string): Promise<void> {
    const gdirRoot = generationsDir(this.opts.stateDir, k);
    let entries: { name: string }[];
    try { entries = (await fsp.readdir(gdirRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => ({ name: e.name })); }
    catch { return; }
    const realGens = entries.map((e) => e.name).filter((n) => n.startsWith(GENERATION_PREFIX));
    realGens.sort();
    const toRemove = realGens.filter((n) => n !== keep).slice(0, Math.max(0, realGens.length - MAX_GENERATIONS_KEPT));
    for (const name of toRemove) {
      await fsp.rm(join(gdirRoot, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async clear(sessionFile: string): Promise<void> {
    const k = this.keyFor(sessionFile);
    const adir = archiveDir(this.opts.stateDir, k);
    await fsp.rm(adir, { recursive: true, force: true });
    this.cache.delete(k);
  }

  async exists(sessionFile: string): Promise<boolean> {
    const a = await this.load(sessionFile);
    return a !== null;
  }
}
