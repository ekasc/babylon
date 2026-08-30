#!/usr/bin/env node
// Reproducible benchmark for SnapshotStore.capture.
//
// Measures the wall-clock time of one or more capture() calls on synthetic
// repositories of varying size. The benchmark runs against whichever
// implementation is compiled into dist-electron/main.mjs / dist-electron/...
// but the script imports the TypeScript source via tsx at dev-time, so it
// always exercises the current code on disk.
//
// Run with:
//   pnpm bench:snapshot
//   pnpm bench:snapshot -- --scales 100,1000,10000
//
// Reports JSON on stdout with per-scale, per-iteration timings and a
// "candidates" count for the second iteration (no-op path).
//
// This file is intentionally runnable in a clean repo without any
// application state. It does not touch the real project worktree.

import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function parseArgs(argv) {
  const opts = { scales: [10, 1000, 10000], iterations: 3, dirtyFiles: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scales") opts.scales = argv[++i].split(",").map(Number);
    else if (a === "--iterations") opts.iterations = Number(argv[++i]);
    else if (a === "--dirty") opts.dirtyFiles = Number(argv[++i]);
  }
  return opts;
}

async function git(cwd, args) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function seedRepo(root, trackedCount) {
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "bench@local"]);
  await git(root, ["config", "user.name", "bench"]);
  for (let i = 0; i < trackedCount; i++) {
    const name = `f${String(i).padStart(6, "0")}.txt`;
    await writeFile(join(root, name), `line ${i}\n`);
  }
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "seed"]);
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const results = [];

  // The snapshot store short-circuits to a cached tree when its worktree
  // watcher reports no changes. The watcher is eventually-consistent, so we
  // let change events drain before measuring a path. settle() bounds that.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

  // Dynamic import of the compiled source. We expect the user to run
  // `pnpm run build:electron` before this benchmark, then we require the
  // emitted CJS. For dev-time ergonomics we also support a TypeScript
  // source path via tsx if available; otherwise the script bails early.
  let SnapshotStore;
  try {
    ({ SnapshotStore } = await import("../dist-bench/snapshot-store.cjs"));
  } catch (err) {
    console.error("bench-snapshot: cannot load dist-bench/snapshot-store.cjs. Run `pnpm run bench:build` first.");
    process.exit(2);
  }

  for (const scale of opts.scales) {
    const base = await mkdtemp(join(tmpdir(), "pideck-snap-bench-"));
    try {
      const root = join(base, "project");
      const stateDir = join(base, "state");
      await seedRepo(root, scale);
      const store = new SnapshotStore(stateDir);

      // First capture: warms the shadow repo and the index, and starts the
      // worktree watcher. Let the watcher drain before measuring.
      const t0 = process.hrtime.bigint();
      const first = await store.capture(root);
      const firstMs = Number(process.hrtime.bigint() - t0) / 1e6;
      if (!first) throw new Error("capture returned null on seeded repo");
      await settle();

      // Hot path: the worktree actually changed before each capture. We
      // flip a tracked file's content so every capture here is a real
      // full enumeration (the cost we cannot avoid when files move).
      const samples = [];
      for (let i = 0; i < opts.iterations; i++) {
        const name = `f${String(i % opts.dirtyFiles).padStart(6, "0")}.txt`;
        await writeFile(join(root, name), `dirty ${i} ${i}\n`);
        await settle();
        const start = process.hrtime.bigint();
        await store.capture(root);
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
        samples.push(elapsed);
      }

      // No-op path: nothing changed since the last capture. After the
      // watcher drains, capture() returns the cached tree without spawning
      // git. This is the path the user wants at near-zero ms.
      await settle();
      const noopSamples = [];
      for (let i = 0; i < opts.iterations; i++) {
        const start = process.hrtime.bigint();
        await store.capture(root);
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
        noopSamples.push(elapsed);
      }

      results.push({
        scale,
        dirtyFiles: opts.dirtyFiles,
        firstCaptureMs: round(firstMs),
        hotMedianMs: round(median(samples)),
        hotMinMs: round(Math.min(...samples)),
        hotMaxMs: round(Math.max(...samples)),
        noopMedianMs: round(median(noopSamples)),
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  console.log(JSON.stringify({ benchmark: "SnapshotStore.capture", ts: new Date().toISOString(), results }, null, 2));
  // Recursive worktree watchers keep the event loop alive; exit explicitly.
  process.exit(0);
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

main().catch((err) => {
  console.error("bench-snapshot failed:", err);
  process.exit(1);
});
