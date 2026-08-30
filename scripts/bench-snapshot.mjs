#!/usr/bin/env node
// Reproducible benchmark for SnapshotStore.capture against the candidate
// algorithm.
//
// For each requested scale we measure:
//   cold init:    first capture() on a fresh repo (seeds the shadow from
//                 the source index, runs the two discovery commands, and
//                 writes the first tree)
//   warm clean:   capture() on an unchanged worktree (0 dirty files; the
//                 discovery commands still run but return empty)
//   warm 1 mod:   capture() after editing one tracked file
//   warm 1 del:   capture() after deleting one tracked file
//   warm 1 new:   capture() after creating one untracked file
//
// Plus, for a smaller scale, a linked worktree case to verify the
// `git rev-parse --path-format=absolute --git-path index` path.
//
// Run with:
//   pnpm bench:snapshot
//   pnpm bench:snapshot -- --scales 10000,50000,100000
//
// Reports JSON on stdout. No pre-declared target: the numbers are the
// numbers. If they are too slow on a real machine, the follow-up is to
// investigate Git fsmonitor / split index / platform behavior, not to
// distort correctness.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

let SnapshotStore;

function parseArgs(argv) {
  const opts = { scales: [10000, 50000, 100000], iterations: 3, worktreeScale: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scales") opts.scales = argv[++i].split(",").map(Number);
    else if (a === "--iterations") opts.iterations = Number(argv[++i]);
    else if (a === "--worktree-scale") opts.worktreeScale = Number(argv[++i]);
    else if (a === "--no-worktree") opts.worktreeScale = 0;
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
  // Write files in batches and add in one shot so seeding itself is fast.
  const batch = [];
  for (let i = 0; i < trackedCount; i++) {
    const name = `f${String(i).padStart(8, "0")}.txt`;
    await writeFile(join(root, name), `line ${i}\n`);
    if ((i + 1) % 5000 === 0) {
      await git(root, ["add", "-A"]);
      batch.length = 0;
    }
  }
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "seed"]);
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

async function time(fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms: round(ms), result };
}

async function measureScale(scale, iterations) {
  const base = await mkdtemp(join(tmpdir(), "pideck-snap-bench-"));
  let store;
  try {
    const root = join(base, "project");
    const stateDir = join(base, "state");
    await seedRepo(root, scale);
    store = new SnapshotStore(stateDir);

    // cold init
    const cold = await time(() => store.capture(root, { authoritative: true }));
    if (!cold.result) throw new Error("capture returned null on seeded repo");

    // warm clean (0 dirty) — the discovery commands run but return empty;
    // this is the steady-state no-edit case.
    const cleanSamples = [];
    for (let i = 0; i < iterations; i++) {
      const t = await time(() => store.capture(root, { authoritative: true }));
      cleanSamples.push(t.ms);
    }

    // warm 1 modified tracked
    const modSamples = [];
    for (let i = 0; i < iterations; i++) {
      const name = `f${String(i).padStart(8, "0")}.txt`;
      await writeFile(join(root, name), `dirty ${i} ${Date.now()}\n`);
      const t = await time(() => store.capture(root, { authoritative: true }));
      modSamples.push(t.ms);
    }

    // warm 1 deleted tracked
    const delSamples = [];
    for (let i = 0; i < iterations; i++) {
      const name = `f${String((iterations + i) % scale).padStart(8, "0")}.txt`;
      await rm(join(root, name));
      const t = await time(() => store.capture(root, { authoritative: true }));
      delSamples.push(t.ms);
    }

    // warm 1 untracked
    const newSamples = [];
    for (let i = 0; i < iterations; i++) {
      const name = `u${i}.txt`;
      await writeFile(join(root, name), `untracked ${i}\n`);
      const t = await time(() => store.capture(root, { authoritative: true }));
      newSamples.push(t.ms);
    }

    return {
      scale,
      coldInitMs: cold.ms,
      warmCleanMedianMs: round(median(cleanSamples)),
      warmCleanMinMs: round(Math.min(...cleanSamples)),
      warm1ModMedianMs: round(median(modSamples)),
      warm1ModMinMs: round(Math.min(...modSamples)),
      warm1DelMedianMs: round(median(delSamples)),
      warm1DelMinMs: round(Math.min(...delSamples)),
      warm1NewMedianMs: round(median(newSamples)),
      warm1NewMinMs: round(Math.min(...newSamples)),
    };
  } finally {
    try {
      store?.dispose();
    } catch {
      // best-effort teardown
    }
    await rmWithRetry(base);
  }
}

async function rmWithRetry(target, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function measureWorktree(scale) {
  const base = await mkdtemp(join(tmpdir(), "pideck-snap-wt-bench-"));
  let store;
  try {
    const main = join(base, "main");
    await mkdir(main);
    await git(main, ["init", "-q", "-b", "main"]);
    await git(main, ["config", "user.email", "bench@local"]);
    await git(main, ["config", "user.name", "bench"]);
    await seedRepo(main, scale);
    const wt = join(base, "wt");
    await git(main, ["worktree", "add", "-b", "wt-branch", wt]);
    store = new SnapshotStore(join(base, "state"));
    const cold = await time(() => store.capture(wt, { authoritative: true }));
    const cleanSamples = [];
    for (let i = 0; i < 3; i++) {
      const t = await time(() => store.capture(wt, { authoritative: true }));
      cleanSamples.push(t.ms);
    }
    return {
      scale,
      linkedWorktree: true,
      coldInitMs: cold.ms,
      warmCleanMedianMs: round(median(cleanSamples)),
      warmCleanMinMs: round(Math.min(...cleanSamples)),
    };
  } finally {
    try {
      store?.dispose();
    } catch {
      // best-effort teardown
    }
    await rmWithRetry(base);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    ({ SnapshotStore } = await import("../dist-bench/snapshot-store.cjs"));
  } catch (err) {
    console.error("bench-snapshot: cannot load dist-bench/snapshot-store.cjs. Run `pnpm run bench:build` first.");
    process.exit(2);
  }

  const results = [];
  for (const scale of opts.scales) {
    process.stdout.write(`scale ${scale}...\n`);
    results.push(await measureScale(scale, opts.iterations));
  }
  if (opts.worktreeScale > 0) {
    process.stdout.write(`worktree ${opts.worktreeScale}...\n`);
    results.push(await measureWorktree(opts.worktreeScale));
  }

  console.log(JSON.stringify({ benchmark: "SnapshotStore.capture (candidate algorithm)", ts: new Date().toISOString(), results }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("bench-snapshot failed:", err);
  process.exit(1);
});
