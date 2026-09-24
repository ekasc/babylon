import { promises as fsp, existsSync } from "node:fs";
import { join } from "node:path";
import { appendDesignLog, designDir, JUDGE_MAX_ROUNDS, type DesignState } from "./store";
import type { ReviewBundle } from "../sim-controller";

/** One review round: the screenshot(s) judged, what the verdict was, and what
 *  still needs fixing. This is the record the review surface renders — one
 *  round per `design_review` call, persisted so it survives a reload. */
export interface DesignReviewShot {
  viewport: string;
  /** Repo-relative path, always inside the design directory. */
  path: string;
  width: number;
  height: number;
}

export interface DesignReviewRecord {
  round: number;
  verdict: "pass" | "fail";
  punchlist: string[];
  note?: string;
  shots: DesignReviewShot[];
  /** True once the round budget is spent: the loop escalates by design. */
  escalated: boolean;
  at: string;
}

/** Review rounds live beside the brief/direction artifacts, one directory per
 *  round so captures are never overwritten by the next attempt. */
export function reviewsDir(cwd: string, slug: string): string {
  return join(designDir(cwd), slug, "reviews");
}

export function reviewRoundDir(cwd: string, slug: string, round: number): string {
  return join(reviewsDir(cwd, slug), `round-${round}`);
}

/** Repo-relative form, matching briefPathFor/directionPathFor. Recorded paths are
 *  relative so they are portable and so a reader can re-validate containment
 *  against the project root instead of trusting an absolute path. */
export function reviewRoundRelPath(slug: string, round: number): string {
  return join(".babylon", "design", slug, "reviews", `round-${round}`);
}

function slugSafe(slug: string): string {
  return slug.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** The next round number: one past the highest round already on disk. Reviews
 *  are counted from the filesystem rather than a counter field so a hand-edited
 *  or partially-written round can never desynchronise the budget. */
export async function nextReviewRound(cwd: string, slug: string): Promise<number> {
  const dir = reviewsDir(cwd, slug);
  if (!existsSync(dir)) return 1;
  const entries = await fsp.readdir(dir);
  let highest = 0;
  for (const entry of entries) {
    const match = /^round-(\d+)$/.exec(entry);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/** Persist a capture bundle as this round's screenshots and return their
 *  repo-relative paths. Writing them is what makes a verdict reviewable later:
 *  without the file, the punchlist would reference a picture nobody can see. */
export async function persistReviewShots(
  cwd: string,
  slug: string,
  round: number,
  bundle: ReviewBundle
): Promise<DesignReviewShot[]> {
  const dir = reviewRoundDir(cwd, slug, round);
  await fsp.mkdir(dir, { recursive: true });
  const shots: DesignReviewShot[] = [];
  for (const shot of bundle.screenshots) {
    const file = `${slugSafe(shot.viewport)}-${shot.preset}.png`;
    await fsp.writeFile(join(dir, file), shot.png);
    shots.push({
      viewport: shot.viewport,
      path: join(reviewRoundRelPath(slug, round), file),
      width: shot.width,
      height: shot.height,
    });
  }
  return shots;
}

/** The newest completed review, read back from disk.
 *
 *  This is the only authority for "which round are we on". A capture that
 *  crashed half way leaves no `review.json`, so it can never be counted — the
 *  label cannot claim a round that never happened. */
export async function latestReview(
  cwd: string,
  slug: string
): Promise<{ round: number; verdict: "pass" | "fail"; escalated: boolean } | null> {
  const dir = reviewsDir(cwd, slug);
  if (!existsSync(dir)) return null;
  const entries = await fsp.readdir(dir);
  let latest: { round: number; verdict: "pass" | "fail"; escalated: boolean } | null = null;
  for (const entry of entries) {
    const match = /^round-(\d+)$/.exec(entry);
    if (!match) continue;
    const round = Number(match[1]);
    try {
      const record = JSON.parse(await fsp.readFile(join(dir, entry, "review.json"), "utf-8")) as {
        round?: unknown;
        verdict?: unknown;
        escalated?: unknown;
      };
      if (typeof record.round !== "number") continue;
      if (record.verdict !== "pass" && record.verdict !== "fail") continue;
      if (latest && record.round <= latest.round) continue;
      latest = {
        round: record.round,
        verdict: record.verdict,
        escalated: record.escalated === true,
      };
    } catch {
      // A half-written round is not a round: skip it rather than guess.
    }
  }
  return latest;
}

/** Record one judged round: the machine-readable record plus a human-readable
 *  log entry, so the design log and the review surface never disagree. */
export async function recordDesignReview(input: {
  cwd: string;
  state: DesignState;
  round: number;
  verdict: "pass" | "fail";
  punchlist: string[];
  note?: string;
  shots: DesignReviewShot[];
}): Promise<DesignReviewRecord> {
  const { cwd, state, round } = input;
  const record: DesignReviewRecord = {
    round,
    verdict: input.verdict,
    punchlist: input.punchlist,
    ...(input.note ? { note: input.note } : {}),
    shots: input.shots,
    escalated: round >= JUDGE_MAX_ROUNDS,
    at: new Date().toISOString(),
  };
  const dir = reviewRoundDir(cwd, state.slug, round);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, "review.json"), JSON.stringify(record, null, 2) + "\n", "utf-8");

  const lines = [
    `### Round ${round} — ${record.verdict.toUpperCase()}`,
    ...(input.shots.length
      ? input.shots.map((s) => `- ${s.viewport} (${s.width}x${s.height}): ${s.path}`)
      : ["- no screenshots (native target: judged from attached captures)"]),
    ...(record.punchlist.length ? ["", "Punchlist:", ...record.punchlist.map((p) => `- ${p}`)] : []),
    ...(record.note ? ["", record.note] : []),
    ...(record.escalated ? ["", `Round budget (${JUDGE_MAX_ROUNDS}) reached: escalate to the user.`] : []),
  ].join("\n");
  await appendDesignLog(cwd, state, lines);

  return record;
}

export function reviewSummary(record: DesignReviewRecord): string {
  const head = `Design review round ${record.round}/${JUDGE_MAX_ROUNDS}: ${record.verdict.toUpperCase()}`;
  const body = record.punchlist.length
    ? `\nPunchlist:\n${record.punchlist.map((p) => `- ${p}`).join("\n")}`
    : "";
  const shots = record.shots.length
    ? `\nScreenshots: ${record.shots.map((s) => `${s.viewport} (${s.width}x${s.height})`).join(", ")}`
    : "\nScreenshots: none recorded";
  const tail = record.escalated ? `\nRound budget reached — escalate in plain chat.` : "";
  return `${head}${shots}${body}${tail}`;
}
