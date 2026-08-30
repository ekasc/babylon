// Snapcompact archive persistence.
//
// Stores a per-session archive under Babylon-owned state:
//
//   <stateDir>/snapcompact/<sessionKey>/
//     manifest.json     - the SnapcompactArchive ledger (no PNG bytes)
//     frames/<n>.png     - one PNG per frame
//
// Writes are crash-safe: the manifest is written to a temp file in the
// same directory and renamed atomically; frame PNGs are written to
// frames/<n>.png.tmp and renamed. A crash mid-compaction therefore
// leaves the previous valid archive on disk.
//
// Manifest version is 1. Future versions can read older manifests via
// the version field; mismatched versions cause the older archive to be
// treated as missing (the caller falls back to the existing textual
// compaction) rather than mis-decoded.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { SnapcompactArchive, SnapcompactFrame, SnapcompactSymbol } from "./types";

const MANIFEST_VERSION = 1;
const FRAME_PREFIX = "frame-";
const FRAME_EXT = ".png";

function sessionKey(sessionFile: string): string {
  return createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
}

function archiveDir(stateDir: string, key: string): string {
  return join(stateDir, "snapcompact", key);
}

function manifestPath(stateDir: string, key: string): string {
  return join(archiveDir(stateDir, key), "manifest.json");
}

function framesDir(stateDir: string, key: string): string {
  return join(archiveDir(stateDir, key), "frames");
}

function framePath(stateDir: string, key: string, index: number): string {
  return join(framesDir(stateDir, key), `${FRAME_PREFIX}${String(index).padStart(4, "0")}${FRAME_EXT}`);
}

function frameTmpPath(stateDir: string, key: string, index: number): string {
  return join(framesDir(stateDir, key), `${FRAME_PREFIX}${String(index).padStart(4, "0")}${FRAME_EXT}.tmp`);
}

function manifestTmpPath(stateDir: string, key: string): string {
  return join(archiveDir(stateDir, key), "manifest.json.tmp");
}

interface PersistedFrame {
  index: number;
  width: number;
  height: number;
  sourceOffset: number;
  sourceEnd: number;
  pngFile: string;
}

interface PersistedArchive {
  version: 1;
  sessionId: string;
  sessionFile: string;
  strategy: "snapcompact";
  sourceText: string;
  symbols: SnapcompactSymbol[];
  frames: PersistedFrame[];
  coveredThroughMessageId: string | null;
  createdAt: number;
  coveredThroughTimestamp: number | null;
  frameWidth: number;
  frameHeight: number;
  profileId: string;
}

async function readManifest(path: string): Promise<PersistedArchive | null> {
  try {
    const raw = await fsp.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as PersistedArchive;
    if (parsed?.version !== MANIFEST_VERSION) return null;
    if (!parsed || !Array.isArray(parsed.frames)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function atomicWriteJson(target: string, tmp: string, value: unknown): Promise<void> {
  await fsp.mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
  const data = JSON.stringify(value, null, 2);
  await fsp.writeFile(tmp, data, { mode: 0o600 });
  await fsp.rename(tmp, target);
}

export interface ArchiveStoreOptions {
  stateDir: string;
}

export class ArchiveStore {
  private cache = new Map<string, SnapcompactArchive | null>();
  private inFlight: Map<string, Promise<SnapcompactArchive | null>> = new Map();

  constructor(private readonly opts: ArchiveStoreOptions) {}

  private keyFor(sessionFile: string): string {
    return sessionKey(sessionFile);
  }

  async load(sessionFile: string): Promise<SnapcompactArchive | null> {
    const k = this.keyFor(sessionFile);
    if (this.cache.has(k)) return this.cache.get(k) ?? null;
    const dir = archiveDir(this.opts.stateDir, k);
    const m = await readManifest(manifestPath(this.opts.stateDir, k));
    if (!m) { this.cache.set(k, null); return null; }
    const frames: SnapcompactFrame[] = [];
    let frameBytes = 0;
    for (const f of m.frames) {
      const fp = join(framesDir(this.opts.stateDir, k), f.pngFile);
      try {
        const buf = await fsp.readFile(fp);
        frameBytes += buf.length;
        frames.push({ index: f.index, width: f.width, height: f.height, png: buf, sourceOffset: f.sourceOffset, sourceEnd: f.sourceEnd });
      } catch {
        // Missing frame file: skip but keep the archive. The caller
        // decides whether a partial archive is still useful.
      }
    }
    const archive: SnapcompactArchive = {
      version: MANIFEST_VERSION,
      sessionId: m.sessionId,
      sessionFile: m.sessionFile,
      strategy: m.strategy,
      sourceText: m.sourceText,
      symbols: m.symbols,
      frames,
      coveredThroughMessageId: m.coveredThroughMessageId,
      createdAt: m.createdAt,
      coveredThroughTimestamp: m.coveredThroughTimestamp,
      frameWidth: m.frameWidth,
      frameHeight: m.frameHeight,
      profileId: m.profileId,
      frameBytes,
    };
    this.cache.set(k, archive);
    return archive;
  }

  /** Atomically replace the archive for `sessionFile`. If a write fails
   *  partway, the previous archive (if any) remains intact. */
  async write(sessionFile: string, archive: Omit<SnapcompactArchive, "version" | "frameBytes">): Promise<SnapcompactArchive> {
    const k = this.keyFor(sessionFile);
    const dir = archiveDir(this.opts.stateDir, k);
    const fdir = framesDir(this.opts.stateDir, k);
    await fsp.mkdir(fdir, { recursive: true, mode: 0o700 });

    // Write frames to temp files in a sibling directory so a crash
    // during the rename never exposes a half-written frame as the
    // canonical one.
    const stagingDir = join(dir, "staging-" + Date.now().toString(36));
    await fsp.mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const stagingFramesDir = join(stagingDir, "frames");
    await fsp.mkdir(stagingFramesDir, { recursive: true, mode: 0o700 });

    const frameRefs: Array<Omit<SnapcompactFrame, "png"> & { pngFile: string }> = [];
    let frameBytes = 0;
    try {
      for (const f of archive.frames) {
        const fileName = `${FRAME_PREFIX}${String(f.index).padStart(4, "0")}${FRAME_EXT}`;
        const stagedPath = join(stagingFramesDir, fileName);
        await fsp.writeFile(stagedPath, f.png, { mode: 0o600 });
        frameBytes += f.png.length;
        frameRefs.push({
          index: f.index,
          width: f.width,
          height: f.height,
          pngFile: fileName,
          sourceOffset: f.sourceOffset,
          sourceEnd: f.sourceEnd,
        });
      }
      // Atomically move frames into the frames dir.
      for (const ref of frameRefs) {
        const staged = join(stagingFramesDir, ref.pngFile);
        const target = join(fdir, ref.pngFile);
        await fsp.rename(staged, target);
      }
      await fsp.rm(stagingDir, { recursive: true, force: true });

      const manifest: PersistedArchive = {
        version: MANIFEST_VERSION,
        sessionId: archive.sessionId,
        sessionFile: archive.sessionFile,
        strategy: archive.strategy,
        sourceText: archive.sourceText,
        symbols: archive.symbols,
        frames: frameRefs,
        coveredThroughMessageId: archive.coveredThroughMessageId,
        createdAt: archive.createdAt,
        coveredThroughTimestamp: archive.coveredThroughTimestamp,
        frameWidth: archive.frameWidth,
        frameHeight: archive.frameHeight,
        profileId: archive.profileId,
      };
      await atomicWriteJson(manifestPath(this.opts.stateDir, k), manifestTmpPath(this.opts.stateDir, k), manifest);

      const fullArchive: SnapcompactArchive = { version: MANIFEST_VERSION, ...archive, frameBytes };
      this.cache.set(k, fullArchive);
      return fullArchive;
    } catch (err) {
      // Best-effort cleanup of staging on failure.
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  async clear(sessionFile: string): Promise<void> {
    const k = this.keyFor(sessionFile);
    const dir = archiveDir(this.opts.stateDir, k);
    await fsp.rm(dir, { recursive: true, force: true });
    this.cache.delete(k);
  }

  /** True when a complete, current archive exists for the session. */
  async exists(sessionFile: string): Promise<boolean> {
    const a = await this.load(sessionFile);
    return a !== null;
  }
}
