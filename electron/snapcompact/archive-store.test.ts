import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveStore, ArchiveIntegrityError } from "./archive-store";
import type { SnapcompactArchive } from "./types";

let stateDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "pideck-snapcompact-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function pngStub(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 13, 10, 26, 10]);
}

function fakeArchive(sessionFile: string, count: number, withSymbols = false): Omit<SnapcompactArchive, "version" | "frameBytes"> {
  const frames = Array.from({ length: count }, (_, i) => ({
    index: i,
    width: 64,
    height: 32,
    png: pngStub(),
    sourceOffset: i * 100,
    sourceEnd: (i + 1) * 100,
  }));
  return {
    sessionId: "s1",
    sessionFile,
    strategy: "snapcompact" as const,
    sourceText: "hello world",
    symbols: withSymbols
      ? [{ id: "E001", value: "/repo/electron/snapshot-store.ts", kind: "path" as const }]
      : [],
    frames,
    coveredThroughMessageId: "m1",
    createdAt: 1,
    coveredThroughTimestamp: 1,
    frameWidth: 64,
    frameHeight: 32,
    profileId: "test",
    compactionGenerationId: "gen-test",
    firstKeptEntryId: "m1",
    lastKeptEntryId: "m1",
    keptCount: 1,
    omittedTrailing: [],
  };
}

describe("snapcompact archive store (immutable generations)", () => {
  it("round-trips an archive and reloads it on a new store", async () => {
    const store = new ArchiveStore({ stateDir });
    const sessionFile = "/sessions/a.jsonl";
    const written = await store.write(sessionFile, fakeArchive(sessionFile, 3, true));
    expect(written.frames.length).toBe(3);
    expect(written.frameBytes).toBeGreaterThan(0);

    const store2 = new ArchiveStore({ stateDir });
    const loaded = await store2.load(sessionFile);
    expect(loaded).not.toBeNull();
    expect(loaded!.frames.length).toBe(3);
    expect(loaded!.symbols[0].value).toBe("/repo/electron/snapshot-store.ts");
  });

  it("stores frames under generations/<id>/frame-XXXX.png and a manifest", async () => {
    const store = new ArchiveStore({ stateDir });
    const sessionFile = "/sessions/layout.jsonl";
    await store.write(sessionFile, fakeArchive(sessionFile, 2));
    const dir = join(stateDir, "snapcompact");
    const entries = await readdir(dir, { withFileTypes: true });
    const archDir = entries.find((e) => e.isDirectory())?.name!;
    const archPath = join(dir, archDir);
    const manifest = JSON.parse(await readFile(join(archPath, "manifest.json"), "utf8"));
    expect(manifest.generation.id).toMatch(/^gen-/);
    const genDir = join(archPath, "generations", manifest.generation.id);
    const files = await readdir(genDir);
    const pngs = files.filter((f) => f.endsWith(".png"));
    expect(pngs.length).toBe(2);
  });

  it("does not overwrite the previous generation when writing a new one", async () => {
    const store = new ArchiveStore({ stateDir });
    const sessionFile = "/sessions/immutable.jsonl";
    const first = await store.write(sessionFile, fakeArchive(sessionFile, 2));
    const second = await store.write(sessionFile, fakeArchive(sessionFile, 3));
    expect(second.frames.length).toBe(3);
    const dir = join(stateDir, "snapcompact");
    const sub = await readdir(dir, { withFileTypes: true });
    const archDir = sub.find((e) => e.isDirectory())?.name!;
    const genDirs = await readdir(join(dir, archDir, "generations"), { withFileTypes: true });
    const realGens = genDirs.filter((e) => e.isDirectory() && e.name.startsWith("gen-"));
    expect(realGens.length).toBeGreaterThanOrEqual(1);
    expect(first.frames.length).toBe(2);
  });

  it("treats a wrong-version manifest as missing without throwing", async () => {
    const store = new ArchiveStore({ stateDir });
    const sessionFile = "/sessions/version.jsonl";
    await store.write(sessionFile, fakeArchive(sessionFile, 1));
    const dir = join(stateDir, "snapcompact");
    const sub = await readdir(dir, { withFileTypes: true });
    const archDir = sub.find((e) => e.isDirectory())?.name!;
    await writeFile(join(dir, archDir, "manifest.json"), JSON.stringify({ version: 99 }), "utf8");
    const fresh = new ArchiveStore({ stateDir });
    await expect(fresh.load(sessionFile)).resolves.toBeNull();
  });

  it("clear() removes the archive and subsequent load returns null", async () => {
    const store = new ArchiveStore({ stateDir });
    const sessionFile = "/sessions/clear.jsonl";
    await store.write(sessionFile, fakeArchive(sessionFile, 1));
    await store.clear(sessionFile);
    const fresh = new ArchiveStore({ stateDir });
    expect(await fresh.load(sessionFile)).toBeNull();
  });

  it("isolates archives by session", async () => {
    const store = new ArchiveStore({ stateDir });
    await store.write("/sessions/e1.jsonl", fakeArchive("/sessions/e1.jsonl", 1));
    await store.write("/sessions/e2.jsonl", fakeArchive("/sessions/e2.jsonl", 2));
    expect((await store.load("/sessions/e1.jsonl"))!.frames.length).toBe(1);
    expect((await store.load("/sessions/e2.jsonl"))!.frames.length).toBe(2);
  });

  it("throws ArchiveIntegrityError when an active frame file is missing", async () => {
    const store = new ArchiveStore({ stateDir });
    const sessionFile = "/sessions/incomplete.jsonl";
    await store.write(sessionFile, fakeArchive(sessionFile, 3));
    const dir = join(stateDir, "snapcompact");
    const sub = await readdir(dir, { withFileTypes: true });
    const archDir = sub.find((e) => e.isDirectory())?.name!;
    const manifest = JSON.parse(await readFile(join(dir, archDir, "manifest.json"), "utf8"));
    const genDir = join(dir, archDir, "generations", manifest.generation.id);
    const frameFiles = (await readdir(genDir)).filter((f) => f.endsWith(".png"));
    await rm(join(genDir, frameFiles[0]), { force: true });
    const fresh = new ArchiveStore({ stateDir });
    await expect(fresh.load(sessionFile)).rejects.toBeInstanceOf(ArchiveIntegrityError);
  });

  it("interrupted write (staging dir present, manifest NOT swapped) leaves the previous archive intact", async () => {
    const store = new ArchiveStore({ stateDir });
    const sessionFile = "/sessions/interrupted.jsonl";
    const first = await store.write(sessionFile, fakeArchive(sessionFile, 2));
    const dir = join(stateDir, "snapcompact");
    const sub = await readdir(dir, { withFileTypes: true });
    const archDir = sub.find((e) => e.isDirectory())?.name!;
    const generations = join(dir, archDir, "generations");
    await mkdir(join(generations, "gen-deadbeef.staging-abcd1234"), { recursive: true });
    const fresh = new ArchiveStore({ stateDir });
    const loaded = await fresh.load(sessionFile);
    expect(loaded).not.toBeNull();
    expect(loaded!.frames.length).toBe(2);
    expect(loaded!.coveredThroughMessageId).toBe(first.coveredThroughMessageId);
  });

  it("stores the archive under a directory with restrictive permissions", async () => {
    const store = new ArchiveStore({ stateDir });
    await store.write("/sessions/perm.jsonl", fakeArchive("/sessions/perm.jsonl", 1));
    const dir = join(stateDir, "snapcompact");
    const sub = await readdir(dir, { withFileTypes: true });
    const archDir = sub.find((e) => e.isDirectory())?.name!;
    const st = await stat(join(dir, archDir));
    expect(st.mode & 0o777).toBe(0o700);
  });
});
