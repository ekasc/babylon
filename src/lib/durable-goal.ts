/**
 * Durable per-session goals, hardbaked into Babylon (vendored from the
 * `goal-mode` pi extension, adapted from per-project to per-session).
 *
 * One file per session: `<cwd>/.pi/state/goal-mode/sessions/<sessionId>.json`.
 * Project-local (travels with the project, like the upstream layout) and
 * already invisible to turn snapshots (`.pi/state/**` is bookkeeping).
 * The `.pi/state/goal-mode/current.json` files written by an external
 * goal-mode copy are a different granularity and are left untouched.
 */

export type DurableGoalStatus =
  | "planning"
  | "executing"
  | "verifying"
  | "blocked"
  | "complete"
  | "cancelled"
  | "paused";

export interface DurableGoalLogEntry {
  at: string;
  event: string;
  details: Record<string, unknown>;
}

export interface DurableGoalState {
  active: boolean;
  paused: boolean;
  objective: string;
  slug: string;
  status: DurableGoalStatus;
  currentStep: string;
  /** ISO timestamp of the `started` log entry; drives the strip clock. */
  startedAt: string;
  /** ISO timestamp while held; excluded from elapsed with the log-derived base. */
  pausedAt?: string | null;
  /** Ms of finished pauses, excluded from the elapsed clock. */
  pausedMs?: number;
  /** ISO timestamp when finished. */
  doneAt?: string;
  turnCount?: number;
  maxTurnsReached?: boolean;
  acceptanceCriteria: string[];
  nonGoals: string[];
  completedSteps: string[];
  evidence: string[];
  log: DurableGoalLogEntry[];
}

export interface DurableGoalModeBehavior {
  injectGoalIntoSystemPrompt: boolean;
  trackAfterEveryAgentEnd: boolean;
  showStatusInTui: boolean;
  autoContinueUntilDone?: boolean;
  maxTurns?: number;
  completionMarker?: string;
}

export interface DurableGoalModeConfig {
  enabled: boolean;
  behavior: DurableGoalModeBehavior;
  defaultAcceptanceCriteria: string[];
  defaultNonGoals: string[];
}

export function defaultDurableGoalModeConfig(): DurableGoalModeConfig {
  return {
    enabled: true,
    behavior: {
      injectGoalIntoSystemPrompt: true,
      trackAfterEveryAgentEnd: true,
      showStatusInTui: true,
      autoContinueUntilDone: true,
      maxTurns: 40,
      completionMarker: "GOAL_DONE",
    },
    defaultAcceptanceCriteria: [
      "Implementation stays inside stated scope.",
      "Changed behavior is verified with tests or explicit command output.",
      "Security-sensitive changes receive review before completion.",
      "Final answer states what changed and how it was verified.",
    ],
    defaultNonGoals: [
      "Do not rewrite unrelated code.",
      "Do not change public behavior outside the objective.",
      "Do not modify infrastructure unless the goal explicitly requires it.",
    ],
  };
}

/** pi session ids are uuid-ish; anything else must never become a path. */
export function isSessionId(value: string): boolean {
  return /^[A-Za-z0-9-]{8,128}$/.test(value);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export function createDurableGoalState(objective: string, config: DurableGoalModeConfig, now: number = Date.now()): DurableGoalState {
  const at = new Date(now).toISOString();
  return {
    active: true,
    paused: false,
    objective,
    slug: slugify(objective),
    status: "planning",
    currentStep: "Inspect relevant files and choose the smallest safe implementation path",
    startedAt: at,
    pausedAt: null,
    pausedMs: 0,
    turnCount: 0,
    maxTurnsReached: false,
    acceptanceCriteria: [...config.defaultAcceptanceCriteria],
    nonGoals: [...config.defaultNonGoals],
    completedSteps: [],
    evidence: [],
    log: [{ at, event: "started", details: { objective } }],
  };
}

/** Narrow untrusted file content to a goal state; null when absent or malformed. */
export function parseDurableGoalState(value: unknown): DurableGoalState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.objective !== "string" || typeof v.startedAt !== "string") return null;
  if (typeof v.active !== "boolean" || typeof v.paused !== "boolean") return null;
  const status = v.status;
  if (
    status !== "planning" && status !== "executing" && status !== "verifying" &&
    status !== "blocked" && status !== "complete" && status !== "cancelled" && status !== "paused"
  ) {
    return null;
  }
  const strArr = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === "string") : [];
  const logRaw = Array.isArray(v.log) ? v.log : [];
  return {
    active: v.active,
    paused: v.paused,
    objective: v.objective,
    slug: typeof v.slug === "string" ? v.slug : "",
    status,
    currentStep: typeof v.currentStep === "string" ? v.currentStep : "",
    startedAt: v.startedAt,
    ...(typeof v.pausedAt === "string" ? { pausedAt: v.pausedAt } : {}),
    ...(typeof v.pausedMs === "number" && v.pausedMs > 0 ? { pausedMs: v.pausedMs } : {}),
    ...(typeof v.doneAt === "string" ? { doneAt: v.doneAt } : {}),
    ...(typeof v.turnCount === "number" && v.turnCount >= 0 ? { turnCount: Math.floor(v.turnCount) } : {}),
    ...(typeof v.maxTurnsReached === "boolean" ? { maxTurnsReached: v.maxTurnsReached } : {}),
    acceptanceCriteria: strArr(v.acceptanceCriteria),
    nonGoals: strArr(v.nonGoals),
    completedSteps: strArr(v.completedSteps),
    evidence: strArr(v.evidence),
    log: logRaw
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => ({
        at: typeof entry.at === "string" ? entry.at : "",
        event: typeof entry.event === "string" ? entry.event : "",
        details:
          typeof entry.details === "object" && entry.details !== null && !Array.isArray(entry.details)
            ? (entry.details as Record<string, unknown>)
            : {},
      })),
  };
}

/** Elapsed ms toward the goal; held while paused, frozen at doneAt once finished. */
export function durableGoalElapsed(state: DurableGoalState, now: number = Date.now()): number {
  const start = Date.parse(state.startedAt);
  if (!Number.isFinite(start)) return 0;
  const pausedAt = state.pausedAt ? Date.parse(state.pausedAt) : NaN;
  const doneAt = state.doneAt ? Date.parse(state.doneAt) : NaN;
  const end = Number.isFinite(doneAt) ? doneAt : Number.isFinite(pausedAt) ? pausedAt : now;
  return Math.max(0, end - start - (state.pausedMs ?? 0));
}

/** H:MM:SS past the hour, M:SS before it. */
export function formatDurableElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function renderDurableGoalContext(state: DurableGoalState, marker = "GOAL_DONE"): string {
  if (!state.active || state.paused) return "";
  return [
    "## Active Goal",
    `Objective: ${state.objective}`,
    `Status: ${state.status}`,
    `Current step: ${state.currentStep}`,
    "Acceptance criteria:",
    ...state.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "Non-goals:",
    ...state.nonGoals.map((nonGoal) => `- ${nonGoal}`),
    "Rules:",
    "- Keep work tied to the objective and avoid unrelated cleanup.",
    "- Use evidence, not claims, to decide whether the goal is complete.",
    `- Only when fully complete, end the final response with ${marker} on its own line.`,
  ].join("\n");
}

/**
 * Unwrap a `{ goal }` wire envelope (daemon socket / IPC): absent reads as
 * no goal, anything else must parse cleanly or the sender is corrupt.
 */
export function unwrapDurableGoalResult(payload: unknown, type: string): DurableGoalState | null {
  const goal =
    payload !== null && typeof payload === "object" && "goal" in payload
      ? (payload as { goal?: unknown }).goal ?? null
      : null;
  if (goal === null) return null;
  const parsed = parseDurableGoalState(goal);
  if (!parsed) throw new Error(`${type} returned a malformed payload`);
  return parsed;
}

/** The agent signals completion with the marker alone on the final line. */
export function durableCompletedWithMarker(text: string, marker: string): boolean {
  const finalLine = text.trimEnd().split(/\r?\n/).at(-1)?.trim();
  return finalLine === marker;
}
