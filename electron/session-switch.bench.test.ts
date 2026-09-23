/**
 * Session-switch benchmark (no thresholds — the numbers are the numbers).
 *
 * Measures the retained-runtime tab-switch path the fingerprint work
 * optimized, at three transcript scales generated with the real
 * SessionManager (user+assistant pairs, auto-persisted to disk).
 *
 * Per scale it records:
 *   cold open ............ full runtime construction for a flushed session
 *   warm clean A→B→A ..... retained reactivations, SessionManager.open count
 *   warm dirty ............ external mtime bump, then B→A (exactly 1 reparse)
 *   warm clean again ...... post-dirty round trip (0 reparses)
 *   hydration breakdown ... getMessages/getState/getStats/getHistory/
 *                            getCommands/getModels timed separately
 *   lru churn .............. 12 small sessions, return to an evicted one
 *   rss .................... process RSS before/after the scale
 *
 * Run with: pnpm bench:sessions
 * Writes JSON to bench-results/session-switch-<timestamp>.json and prints
 * a summary. Local runtime only (daemon IPC fan-out is a separate pass).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost } from "./pi-host";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const TURNS = [100, 1000, 5000];
const SWITCH_ITERATIONS = 5;

interface ScaleResult {
  turns: number;
  messages: number;
  transcriptBytes: number;
  coldOpenMs: number;
  warmCleanSwitchMs: { median: number; p95: number; max: number; samples: number[] };
  warmCleanReparses: number;
  warmDirtySwitchMs: number;
  warmDirtyReparses: number;
  warmCleanAgainReparses: number;
  hydrationMs: Record<string, number>;
  rssBeforeMB: number;
  rssAfterMB: number;
}

interface ChurnResult {
  sessionsOpened: number;
  firstEvicted: boolean;
  evictedReopenMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 50);
}

async function makeProject(tag: string) {
  const root = await mkdtemp(join(tmpdir(), `pideck-bench-${tag}-`));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { root, cwd, agentDir };
}

function seedTranscript(cwd: string, turns: number): string {
  const manager = SessionManager.create(cwd);
  const file = manager.getSessionFile()!;
  for (let i = 0; i < turns; i++) {
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: `turn ${i}: ${"do the thing ".repeat(20)}` }],
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `result ${i}: ${"done and dusted ".repeat(40)}` }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }
  return file;
}

describe("session-switch bench", () => {
  it("measures retained, dirty, cold, churn, and hydration costs", async () => {
    const { cwd, agentDir } = await makeProject("switch");
    const host = new PiHost({ cwd, agentDir, onEvent: () => undefined, onStatus: () => undefined });
    await host.start();
    const openSpy = vi.spyOn(SessionManager, "open");
    const scales: ScaleResult[] = [];
    try {
      for (const turns of TURNS) {
        const rssBeforeMB = process.memoryUsage().rss / 1024 / 1024;
        const fileA = seedTranscript(cwd, turns);
        const fileB = seedTranscript(cwd, Math.max(10, Math.floor(turns / 10)));
        const stat = await fsp.stat(fileA);
        const manager = SessionManager.open(fileA, undefined, cwd);
        const messages = manager.getEntries().length;

        // Cold open: full runtime construction for a flushed session.
        openSpy.mockClear();
        let start = performance.now();
        await host.open({ path: fileA, cwd });
        const coldOpenMs = performance.now() - start;

        // Warm clean A→B→A: retained reactivations. One unmeasured round
        // trip first: creation seeds the fingerprint, but the SDK flushes
        // during the build, so the first reactivation legitimately syncs
        // once per session — steady state is what we measure.
        await host.open({ path: fileB, cwd });
        await host.open({ path: fileA, cwd });
        openSpy.mockClear();
        const samples: number[] = [];
        for (let i = 0; i < SWITCH_ITERATIONS; i++) {
          start = performance.now();
          await host.open({ path: fileB, cwd });
          samples.push(performance.now() - start);
          start = performance.now();
          await host.open({ path: fileA, cwd });
          samples.push(performance.now() - start);
        }
        const warmCleanReparses = openSpy.mock.calls.length;
        const sorted = [...samples].sort((a, b) => a - b);

        // Warm dirty: external change, then B→A must reparse exactly once.
        openSpy.mockClear();
        const future = new Date(Date.now() + 60_000);
        await fsp.utimes(fileA, future, future);
        start = performance.now();
        await host.open({ path: fileA, cwd });
        const warmDirtySwitchMs = performance.now() - start;
        const warmDirtyReparses = openSpy.mock.calls.length;

        // Clean again: the post-dirty round trip reparses nothing.
        openSpy.mockClear();
        await host.open({ path: fileB, cwd });
        await host.open({ path: fileA, cwd });
        const warmCleanAgainReparses = openSpy.mock.calls.length;

        // Hydration breakdown on the foreground session.
        const hydrationMs: Record<string, number> = {};
        const timed = async (name: string, fn: () => Promise<unknown>) => {
          const t0 = performance.now();
          await fn();
          hydrationMs[name] = performance.now() - t0;
        };
        await timed("getMessages", () => host.getMessages());
        await timed("getState", () => host.getState());
        await timed("getStats", () => host.getStats());
        await timed("getHistory", () => host.getHistory());
        await timed("getCommands", () => host.getCommands());
        await timed("getModels", () => host.getModels());

        scales.push({
          turns,
          messages,
          transcriptBytes: stat.size,
          coldOpenMs,
          warmCleanSwitchMs: {
            median: median(samples),
            p95: percentile(sorted, 95),
            max: sorted[sorted.length - 1]!,
            samples,
          },
          warmCleanReparses,
          warmDirtySwitchMs,
          warmDirtyReparses,
          warmCleanAgainReparses,
          hydrationMs,
          rssBeforeMB,
          rssAfterMB: process.memoryUsage().rss / 1024 / 1024,
        });
      }

      // LRU churn with small sessions: open past the cap, return to one
      // that was evicted, and measure the cold rebuild users actually feel
      // with many tabs.
      const churnFiles: string[] = [];
      for (let i = 0; i < 12; i++) {
        const file = seedTranscript(cwd, 5);
        churnFiles.push(file);
        await host.open({ path: file, cwd });
      }
      const firstEvicted = !host.testSessions().has(churnFiles[0]!);
      const churnStart = performance.now();
      await host.open({ path: churnFiles[0]!, cwd });
      const churn: ChurnResult = {
        sessionsOpened: churnFiles.length,
        firstEvicted,
        evictedReopenMs: performance.now() - churnStart,
      };

      const report = {
        tool: "bench:sessions",
        mode: "local",
        node: process.version,
        platform: process.platform,
        iterations: SWITCH_ITERATIONS,
        scales,
        churn,
      };
      const outDir = join(process.cwd(), "bench-results");
      await mkdir(outDir, { recursive: true });
      const outFile = join(outDir, `session-switch-${Date.now()}.json`);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`\nbench:sessions → ${outFile}`);
      for (const s of scales) {
        console.log(
          `turns=${s.turns} msgs=${s.messages} bytes=${s.transcriptBytes} ` +
            `cold=${s.coldOpenMs.toFixed(0)}ms ` +
            `warmClean[median=${s.warmCleanSwitchMs.median.toFixed(1)}ms p95=${s.warmCleanSwitchMs.p95.toFixed(1)}ms] ` +
            `reparses(clean=${s.warmCleanReparses},dirty=${s.warmDirtyReparses},again=${s.warmCleanAgainReparses}) ` +
            `hydration=${Object.entries(s.hydrationMs).map(([k, v]) => `${k}=${v.toFixed(1)}ms`).join(" ")} ` +
            `rss=${s.rssBeforeMB.toFixed(0)}→${s.rssAfterMB.toFixed(0)}MB`
        );
      }
      console.log(
        `churn: opened=${churn.sessionsOpened} firstEvicted=${churn.firstEvicted} evictedReopen=${churn.evictedReopenMs.toFixed(0)}ms`
      );
    } finally {
      openSpy.mockRestore();
      await host.dispose();
    }
  }, 600_000);
});
