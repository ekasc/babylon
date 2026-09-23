import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isSessionId, slugify } from "../../src/lib/durable-goal";

/** Bounded automation: the judge gets this many revise rounds, then pi
 *  escalates to the user with captures + punchlist attached. */
export const JUDGE_MAX_ROUNDS = 3;

/** Where the designed thing runs. Decided in the interview (the agent
 *  records it via `/design set-target`); the judge loop branches on it:
 *  web targets are captured by URL, native targets from attached
 *  simulator screenshots. */
export const DESIGN_TARGETS = ["web", "mobile-web", "native"] as const;
export type DesignTarget = (typeof DESIGN_TARGETS)[number];

export function parseDesignTarget(value: unknown): DesignTarget | null {
  return typeof value === "string" && (DESIGN_TARGETS as readonly string[]).includes(value)
    ? (value as DesignTarget)
    : null;
}

export interface DesignState {
  slug: string;
  subject: string;
  /** App target; "web" unless the interview recorded otherwise. */
  target: DesignTarget;
  /** Paths relative to the project cwd (survive thread disposal). */
  briefPath: string;
  brandPath: string;
  logPath: string;
  briefApproved: boolean;
  brandApproved: boolean;
  done: boolean;
  updatedAt: string;
}

export type DesignStage =
  | "idle"
  | "elicit"
  | "brief-confirm"
  | "brand"
  | "build"
  | "done";

/** Pure stage derivation: what exists decides what happens next, so
 *  re-running /design always continues from the current artifacts. */
export function stageFor(
  state: DesignState | null,
  briefExists: boolean,
  brandExists: boolean
): DesignStage {
  if (!state || state.done) return state?.done ? "done" : "idle";
  if (!state.briefApproved || !briefExists) return briefExists ? "brief-confirm" : "elicit";
  if (!state.brandApproved || !brandExists) return "brand";
  return "build";
}

/** Workspace home for design artifacts. In-repo by design: human-readable,
 *  survives thread disposal, syncs with the project. */
export function designDir(cwd: string): string {
  return join(cwd, ".babylon", "design");
}

export function briefPathFor(slug: string): string {
  return join(".babylon", "design", `${slug}-brief.md`);
}

export function brandPathFor(slug: string): string {
  return join(".babylon", "design", `${slug}-brand.md`);
}

export function logPathFor(slug: string): string {
  return join(".babylon", "design", `${slug}-log.md`);
}

export function createDesignState(subject: string, slug: string): DesignState {
  return {
    slug,
    subject,
    target: "web",
    briefPath: briefPathFor(slug),
    brandPath: brandPathFor(slug),
    logPath: logPathFor(slug),
    briefApproved: false,
    brandApproved: false,
    done: false,
    updatedAt: new Date().toISOString(),
  };
}

/** Slug with a collision-proof fallback: slugify yields "" for subjects
 *  like "!!!", which would otherwise share one artifact path. */
export function slugFor(subject: string): string {
  return slugify(subject) || `untitled-${randomUUID().slice(0, 8)}`;
}

/** Clear approvals whose artifact is gone. A rewritten brief always needs
 *  fresh confirmation — it must never inherit a stale approval, and a new
 *  brief invalidates the old brand with it. */
export function sanitizedStateFor(
  state: DesignState,
  briefExists: boolean,
  brandExists: boolean
): DesignState {
  if (!briefExists) return { ...state, briefApproved: false, brandApproved: false };
  if (!brandExists) return { ...state, brandApproved: false };
  return state;
}

/** Absolute state-file path for a session. Throws on a hostile id (fail closed). */
export function designFileForSession(cwd: string, sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error("invalid session id for design state");
  return join(designDir(cwd), "sessions", `${sessionId}.json`);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function isDesignState(value: unknown): value is DesignState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.slug === "string" &&
    typeof v.subject === "string" &&
    typeof v.briefPath === "string" &&
    typeof v.brandPath === "string" &&
    typeof v.logPath === "string"
  );
}

export async function loadDesignState(cwd: string, sessionId: string): Promise<DesignState | null> {
  let path: string;
  try {
    path = designFileForSession(cwd, sessionId);
  } catch {
    return null;
  }
  const raw = await readJson<unknown>(path, null);
  if (!isDesignState(raw)) return null;
  // Stored paths are trusted by the log writer and the approve guards: they
  // must be exactly the slug-derived paths, never a hand-edited escape.
  if (
    raw.briefPath !== briefPathFor(raw.slug) ||
    raw.brandPath !== brandPathFor(raw.slug) ||
    raw.logPath !== logPathFor(raw.slug)
  ) {
    return null;
  }
  // Target arrived later than the state file: old sessions without it (or
  // with a hand-edited bogus value) read as "web", never as missing.
  return { ...raw, target: parseDesignTarget(raw.target) ?? "web" };
}

export async function saveDesignState(
  cwd: string,
  sessionId: string,
  state: DesignState
): Promise<void> {
  const path = designFileForSession(cwd, sessionId);
  await mkdir(join(designDir(cwd), "sessions"), { recursive: true });
  await writeFile(path, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf-8");
}

export async function clearDesignState(cwd: string, sessionId: string): Promise<void> {
  try {
    await rm(designFileForSession(cwd, sessionId), { force: true });
  } catch {
    /* already gone */
  }
}

/** Stage for a loaded state against the live worktree. Main-process only
 *  (sync existence checks): the renderer cannot stat files, so IPC
 *  (`designGet` / `designControl`) returns this alongside the state. */
export function stageOfState(cwd: string, state: DesignState | null): DesignStage {
  if (!state) return "idle";
  const briefExists = existsSync(join(cwd, state.briefPath));
  const brandExists = existsSync(join(cwd, state.brandPath));
  const clean = sanitizedStateFor(state, briefExists, brandExists);
  return stageFor(clean, existsSync(join(cwd, clean.briefPath)), existsSync(join(cwd, clean.brandPath)));
}
/** Design state plus its live stage: what `designGet` / `designControl`
 *  return. The renderer cannot stat files, so the stage travels with the state. */
export interface DesignStatus {
  design: DesignState | null;
  stage: DesignStage;
}
/** Unwrap a `pi.designControl` / `pideck:design-control` payload: null design
 *  when no design session, never a bare non-object. Throws on malformed state. */
export function unwrapDesignResult(payload: unknown, type: string): DesignStatus {
  if (payload === null || typeof payload !== "object" || !("design" in payload)) {
    throw new Error(`${type} returned a malformed payload`);
  }
  const design = (payload as { design?: unknown }).design ?? null;
  if (design !== null && !isDesignState(design)) throw new Error(`${type} returned a malformed payload`);
  const rawStage = (payload as { stage?: unknown }).stage;
  const stage: DesignStage =
    rawStage === "idle" || rawStage === "elicit" || rawStage === "brief-confirm" || rawStage === "brand" || rawStage === "build" || rawStage === "done"
      ? rawStage
      : design
        ? "elicit"
        : "idle";
  return { design, stage };
}

/**
 * Transactional design-start outcome. Same contract as GoalBeginResult:
 * turn failures return normally (never throw) — `started: false` means the
 * message never became a turn, `started: true` means it did. The stage
 * travels with the state (the renderer cannot stat artifacts).
 */
export interface DesignBeginResult {
  design: DesignState | null;
  stage: DesignStage;
  started: boolean;
  error: string | null;
}

/** Unwrap a `DesignBeginResult` wire envelope. Strict: every key required,
 *  and the stage must be a known value — no silent fallback (unlike
 *  `unwrapDesignResult`, which keeps a legacy default for older senders). */
export function unwrapDesignBeginResult(payload: unknown, type: string): DesignBeginResult {
  if (payload === null || typeof payload !== "object") throw new Error(`${type} returned a malformed payload`);
  const record = payload as Record<string, unknown>;
  if (!("design" in record) || !("stage" in record) || !("started" in record) || !("error" in record)) {
    throw new Error(`${type} returned a malformed payload`);
  }
  const rawDesign = record.design ?? null;
  const design = rawDesign === null ? null : isDesignState(rawDesign) ? rawDesign : null;
  if (rawDesign !== null && design === null) throw new Error(`${type} returned a malformed payload`);
  const rawStage = record.stage;
  if (
    rawStage !== "idle" &&
    rawStage !== "elicit" &&
    rawStage !== "brief-confirm" &&
    rawStage !== "brand" &&
    rawStage !== "build" &&
    rawStage !== "done"
  ) {
    throw new Error(`${type} returned a malformed payload`);
  }
  if (typeof record.started !== "boolean") throw new Error(`${type} returned a malformed payload`);
  if (record.error !== null && typeof record.error !== "string") {
    throw new Error(`${type} returned a malformed payload`);
  }
  return { design, stage: rawStage, started: record.started, error: record.error };
}

/** Prepend a timestamped entry to the design log (newest-first), creating
 *  the file with a title on first use. Every visual decision gets a
 *  picture answer: pi records capture paths + verdicts + punchlists here. */
export async function appendDesignLog(cwd: string, state: DesignState, entry: string): Promise<void> {
  const path = join(cwd, state.logPath);
  await mkdir(designDir(cwd), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(path, "utf-8");
  } catch {
    existing = `# Design log: ${state.subject}\n`;
  }
  const block = `\n## ${new Date().toISOString()}\n\n${entry.trim()}\n`;
  const lines = existing.split("\n");
  const title = lines[0] ?? `# Design log: ${state.subject}`;
  const rest = lines.slice(1).join("\n");
  await writeFile(path, `${title}\n${block}${rest.trim() ? `\n${rest.trim()}\n` : ""}`, "utf-8");
}
