import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nextReviewRound,
  persistReviewShots,
  recordDesignReview,
  reviewRoundDir,
  reviewShotPath,
  reviewSummary,
} from "./review";
import { createDesignState, JUDGE_MAX_ROUNDS } from "./store";
import type { ReviewBundle } from "../sim-controller";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))));

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-review-${tag}-`));
  roots.push(cwd);
  return cwd;
}

const bundle = (): ReviewBundle => ({
  url: "http://localhost:5173",
  screenshots: [
    { viewport: "iPhone 15 Pro", preset: "iphone", png: Buffer.from("png-mobile"), width: 390, height: 844 },
    { viewport: "Chrome", preset: "chrome-laptop", png: Buffer.from("png-desktop"), width: 1280, height: 800 },
  ],
  consoleErrors: [],
  pageErrors: [],
  textSnapshot: "Sessions",
  axSnapshot: "ax",
});

describe("design review rounds", () => {
  it("numbers rounds from what is on disk, starting at one", async () => {
    const cwd = await makeProject("rounds");
    const state = createDesignState("Sessions UI", "sessions-ui");
    expect(await nextReviewRound(cwd, state.slug)).toBe(1);
    await recordDesignReview({ cwd, state, round: 1, verdict: "fail", punchlist: ["tight"], shots: [] });
    expect(await nextReviewRound(cwd, state.slug)).toBe(2);
    await recordDesignReview({ cwd, state, round: 2, verdict: "fail", punchlist: [], shots: [] });
    expect(await nextReviewRound(cwd, state.slug)).toBe(3);
  });

  it("persists screenshots and returns containment-safe repo-relative paths", async () => {
    const cwd = await makeProject("shots");
    const state = createDesignState("Sessions UI", "sessions-ui");
    const shots = await persistReviewShots(cwd, state.slug, 1, bundle());
    expect(shots).toHaveLength(2);
    expect(shots[0]?.viewport).toBe("iPhone 15 Pro");
    // Viewport labels are slugged for the filesystem (spaces are safe either
    // way, but the recorded path must be a plain file name).
    expect(shots[0]?.path).toBe(join(".babylon", "design", "sessions-ui", "reviews", "round-1", "iPhone_15_Pro-iphone.png"));
    // The bytes are real files, so the verdict stays reviewable after reload.
    const onDisk = await readFile(join(cwd, shots[0]!.path), "utf-8");
    expect(onDisk).toBe("png-mobile");
    expect(existsSync(join(cwd, shots[1]!.path))).toBe(true);
  });

  it("writes a machine-readable record and a matching log entry", async () => {
    const cwd = await makeProject("record");
    const state = createDesignState("Sessions UI", "sessions-ui");
    const shots = await persistReviewShots(cwd, state.slug, 1, bundle());
    const record = await recordDesignReview({
      cwd,
      state,
      round: 1,
      verdict: "fail",
      punchlist: ["Header spacing is too tight", "CTA wraps below 390px"],
      note: "Hierarchy improved.",
      shots,
    });

    const written = JSON.parse(
      await readFile(join(reviewRoundDir(cwd, state.slug, 1), "review.json"), "utf-8")
    ) as typeof record;
    expect(written.verdict).toBe("fail");
    expect(written.round).toBe(1);
    expect(written.punchlist).toEqual(["Header spacing is too tight", "CTA wraps below 390px"]);
    expect(written.shots).toHaveLength(2);
    expect(written.escalated).toBe(false);

    // The log says the same thing in prose form.
    const log = await readFile(join(cwd, state.logPath), "utf-8");
    expect(log).toContain("Round 1 — FAIL");
    expect(log).toContain("Header spacing is too tight");
    expect(log).toContain("Hierarchy improved.");
  });

  it("marks the last budgeted round as escalated, and says so", async () => {
    const cwd = await makeProject("escalate");
    const state = createDesignState("Sessions UI", "sessions-ui");
    const record = await recordDesignReview({
      cwd,
      state,
      round: JUDGE_MAX_ROUNDS,
      verdict: "fail",
      punchlist: ["Still off"],
      shots: [],
    });
    expect(record.escalated).toBe(true);
    expect(reviewSummary(record)).toContain("escalate in plain chat");
    const log = await readFile(join(cwd, state.logPath), "utf-8");
    expect(log).toContain(`Round budget (${JUDGE_MAX_ROUNDS}) reached`);
  });

  it("summarizes a passing round with its shots and no punchlist", async () => {
    const cwd = await makeProject("pass");
    const state = createDesignState("Sessions UI", "sessions-ui");
    const shots = await persistReviewShots(cwd, state.slug, 1, bundle());
    const record = await recordDesignReview({ cwd, state, round: 1, verdict: "pass", punchlist: [], shots });
    const summary = reviewSummary(record);
    expect(summary).toContain("1/3: PASS");
    expect(summary).toContain("iPhone 15 Pro (390x844)");
    expect(summary).not.toContain("Punchlist");
  });

  it("records a native round with no captured shots rather than inventing any", async () => {
    const cwd = await makeProject("native");
    const state = createDesignState("App", "app");
    const record = await recordDesignReview({ cwd, state, round: 1, verdict: "fail", punchlist: ["n"], shots: [] });
    expect(record.shots).toEqual([]);
    const log = await readFile(join(cwd, state.logPath), "utf-8");
    expect(log).toContain("no screenshots");
  });

  it("resolves a capture by identity, not by a caller-supplied path", async () => {
    const cwd = await makeProject("identity");
    const state = createDesignState("Sessions UI", "sessions-ui");
    const shots = await persistReviewShots(cwd, state.slug, 2, bundle());
    await recordDesignReview({ cwd, state, round: 2, verdict: "fail", punchlist: ["x"], shots });

    // The round's own record is the authority for where a capture lives.
    expect(await reviewShotPath(cwd, state.slug, 2, "iPhone 15 Pro")).toBe(shots[0]!.path);
    // An unknown viewport is a miss, not a path to probe.
    await expect(reviewShotPath(cwd, state.slug, 2, "Firefox")).rejects.toThrow(/no such review screenshot/);
    // A round that was never recorded cannot be read.
    await expect(reviewShotPath(cwd, state.slug, 7, "iPhone 15 Pro")).rejects.toThrow();
  });

  it("keeps rounds isolated: a later round never overwrites earlier captures", async () => {
    const cwd = await makeProject("isolated");
    const state = createDesignState("Sessions UI", "sessions-ui");
    await persistReviewShots(cwd, state.slug, 1, bundle());
    await writeFile(join(reviewRoundDir(cwd, state.slug, 1), "marker.txt"), "round-one", "utf-8");
    await persistReviewShots(cwd, state.slug, 2, bundle());
    await mkdir(reviewRoundDir(cwd, state.slug, 3), { recursive: true });
    expect(existsSync(join(reviewRoundDir(cwd, state.slug, 1), "marker.txt"))).toBe(true);
    expect(existsSync(join(reviewRoundDir(cwd, state.slug, 2), "Chrome-chrome-laptop.png"))).toBe(true);
  });
});
