// Workflows bridge — reads pi-dynamic-workflows run state from disk and
// exposes it to the renderer over IPC.
//
// The extension persists each workflow run as `<runId>.json` (atomic
// tmp-write + rename, with `.bak`/`.lock` sidecars). Newer versions write to
// the user-level project namespace under `~/.pi/workflows/projects/<key>/runs`
// (key = `<slug>-<sha256(cwd)[0..12]>`); older ones write project-relative to
// `<cwd>/.pi/workflows/runs`. Both locations are scanned, primary first, with
// the same runId deduped in favor of the primary copy.
//
// Control (pause/resume/stop/rm) is delegated to the extension's `/workflows`
// slash command via the in-process pi session: `session.prompt("/workflows …")`
// executes extension commands immediately, even mid-stream, without adding a
// chat message or hitting the LLM (verified in the SDK's agent-session:
// `_tryExecuteExtensionCommand` intercepts leading "/"). `retry` is NOT a
// /workflows subcommand, so it is rejected here.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type WorkflowRunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export type WorkflowControlAction = "pause" | "resume" | "stop" | "retry";

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "aborted"]);
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;

function validRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

/** Light per-agent row used in run summaries (matches PersistedAgentState). */
export interface WorkflowAgentSummary {
  id: number;
  label: string;
  status: string;
  phase?: string;
}

export interface WorkflowRunSummary {
  runId: string;
  workflowName: string;
  description?: string;
  status: WorkflowRunStatus;
  /** Owning pi session — used to gate control buttons (foreign runs can't be controlled). */
  sessionId?: string;
  phases: string[];
  currentPhase?: string;
  agents: WorkflowAgentSummary[];
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

/** Full per-agent state (agent detail view). */
export interface WorkflowAgentState extends WorkflowAgentSummary {
  prompt?: unknown; // opaque: current run files store the agent options object here
  result?: unknown;
  resultPreview?: string;
  error?: string;
  errorCode?: string;
  recoverable?: boolean;
  history?: { role: string; content?: string; kind?: string; toolName?: string; text?: string; isError?: boolean; timestamp?: number }[];
  queuedAt?: string;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  attempt?: number;
  maxAttempts?: number;
  waitReason?: string;
  tokens?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  model?: string;
}

/** Full run state (run detail view). */
export interface WorkflowRunDetail extends WorkflowRunSummary {
  script: string;
  args?: unknown;
  agents: WorkflowAgentState[];
  logs: string[];
  result?: unknown;
  error?: string;
  errorCode?: string;
  pauseReason?: string;
  resetHint?: string;
}

export interface WorkflowsUpdate {
  runs: WorkflowRunSummary[];
}

export interface WorkflowsBridgeOptions {
  /** Project cwd the runs belong to (from the pi host session). */
  cwd: string;
  /** Override only for isolated tests; defaults to ~/.pi/workflows. */
  workflowHomeDir?: string;
  /** Execute an extension command via the in-process pi session (`/workflows …`). */
  runCommand: (command: string) => Promise<unknown>;
  /** Current pi session id. Runs owned by other sessions are not exposed. */
  getSessionId?: () => Promise<string | null | undefined>;
  /** Called with fresh summaries whenever the poll detects a change. */
  onUpdate: (runs: WorkflowRunSummary[]) => void;
  pollIntervalMs?: number;
}

interface ParsedRun {
  state: WorkflowRunDetail;
  path: string;
  mtimeMs: number;
  size: number;
}

/** Stable per-project namespace key, mirroring workflowProjectKey() in the extension. */
function projectKey(cwd: string): string {
  const projectPath = resolve(cwd);
  const slug = (basename(projectPath) || "project")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

export class WorkflowsBridge {
  readonly cwd: string;
  private opts: WorkflowsBridgeOptions;
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private lastSignature = "";
  private lastRuns: WorkflowRunSummary[] = [];
  private parsedByPath = new Map<string, { signature: string; run: ParsedRun }>();

  constructor(opts: WorkflowsBridgeOptions) {
    this.opts = opts;
    this.cwd = opts.cwd;
  }

  /** Runs dirs for this project: lexical and canonical namespaces, then legacy. */
  private async runsDirs(): Promise<string[]> {
    const workflowHome = this.opts.workflowHomeDir ?? join(homedir(), ".pi", "workflows");
    const cwdPaths = [resolve(this.cwd)];
    try {
      const canonical = await fsp.realpath(this.cwd);
      if (!cwdPaths.includes(canonical)) cwdPaths.push(canonical);
    } catch {
      // The session lifecycle handles missing cwd. Keep lexical lookup usable.
    }
    return [
      ...cwdPaths.map((cwd) => join(workflowHome, "projects", projectKey(cwd), "runs")),
      join(this.cwd, ".pi", "workflows", "runs"),
    ];
  }

  start(): void {
    if (this.timer) return;
    this.active = true;
    // Prime immediately (don't wait a full interval for the first payload).
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.pollIntervalMs ?? 1500);
  }

  dispose(): void {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private async scan(): Promise<{ runs: ParsedRun[]; signature: string }> {
    const byRunId = new Map<string, ParsedRun>();
    const sigParts: string[] = [];
    const seenPaths = new Set<string>();
    for (const dir of await this.runsDirs()) {
      let entries: string[];
      try {
        entries = await fsp.readdir(dir);
      } catch {
        continue; // missing dir (the common case) or unreadable — never crash
      }
      for (const name of entries) {
        if (!name.endsWith(".json")) continue; // skip .bak/.lock/.tmp sidecars
        const path = join(dir, name);
        try {
          const stat = await fsp.stat(path);
          if (!stat.isFile()) continue;
          const fileSignature = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
          sigParts.push(`${name}:${fileSignature}`);
          seenPaths.add(path);
          let parsed = this.parsedByPath.get(path)?.signature === fileSignature
            ? this.parsedByPath.get(path)!.run
            : undefined;
          if (!parsed) {
            const raw = await fsp.readFile(path, "utf8");
            const state = JSON.parse(raw) as WorkflowRunDetail;
            if (!state || typeof state.runId !== "string") continue;
            parsed = { state, path, mtimeMs: stat.mtimeMs, size: stat.size };
            this.parsedByPath.set(path, { signature: fileSignature, run: parsed });
          }
          // Primary dir wins on runId collision with the legacy dir.
          if (!byRunId.has(parsed.state.runId)) byRunId.set(parsed.state.runId, parsed);
        } catch {
          // Corrupt/truncated file (a write is atomic, but a crash could still
          // leave a bad one) — skip it; the .bak is only consulted on demand.
          continue;
        }
      }
    }
    for (const path of this.parsedByPath.keys()) {
      if (!seenPaths.has(path)) this.parsedByPath.delete(path);
    }
    const runs = [...byRunId.values()].sort(
      (a, b) =>
        new Date(b.state.updatedAt ?? 0).getTime() - new Date(a.state.updatedAt ?? 0).getTime()
    );
    sigParts.sort();
    return { runs, signature: `${runs.length}|${sigParts.join("|")}` };
  }

  private async refresh(): Promise<void> {
    try {
      const { runs, signature } = await this.scan();
      if (!this.active) return;
      const sessionId = await this.opts.getSessionId?.();
      if (!this.active) return;
      const summaries = runs
        .filter((run) => !run.state.sessionId || run.state.sessionId === sessionId)
        .map((run) => toSummary(run.state));
      const scopedSignature = `${sessionId ?? "legacy"}|${signature}`;
      this.lastRuns = summaries;
      if (scopedSignature !== this.lastSignature) {
        this.lastSignature = scopedSignature;
        this.opts.onUpdate(summaries);
      }
    } catch {
      // Poll loop must never die: keep the last good state and try again next tick.
    }
  }

  // -------------------------------------------------------------------------
  // IPC surface
  // -------------------------------------------------------------------------

  /** Fresh summaries scoped to the active conversation session. */
  async list(): Promise<WorkflowRunSummary[]> {
    try {
      const { runs } = await this.scan();
      const sessionId = await this.opts.getSessionId?.();
      const summaries = runs
        .filter((run) => !run.state.sessionId || run.state.sessionId === sessionId)
        .map((run) => toSummary(run.state));
      this.lastRuns = summaries;
      return summaries;
    } catch {
      return this.lastRuns;
    }
  }

  /** Full run state for one runId in the active session, with .bak recovery. */
  async get(runId: string): Promise<WorkflowRunDetail | null> {
    if (!validRunId(runId)) return null;
    const sessionId = await this.opts.getSessionId?.();
    for (const dir of await this.runsDirs()) {
      for (const name of [`${runId}.json`, `${runId}.json.bak`]) {
        try {
          const raw = await fsp.readFile(join(dir, name), "utf8");
          const state = JSON.parse(raw) as WorkflowRunDetail;
          if (
            state &&
            state.runId === runId &&
            (!state.sessionId || state.sessionId === sessionId)
          ) return state;
        } catch {
          // try next candidate
        }
      }
    }
    return null;
  }

  /**
   * Delete a terminal run. For runs owned by the current pi session, prefer the
   * `/workflows rm` command so the in-memory manager forgets it too; for foreign
   * runs (or when the command fails) remove the files directly — the file is the
   * source of truth. Never deletes a live run's file (the manager would rewrite
   * it on the next save and resurrect it).
   */
  async delete(runId: string): Promise<boolean> {
    if (!validRunId(runId)) throw new Error("invalid workflow run id");
    const state = await this.get(runId);
    if (!state) return false;
    if (state && !TERMINAL_RUN_STATUSES.has(state.status)) {
      throw new Error(`cannot delete a ${state.status} run — stop or wait for it to finish first`);
    }
    if (state?.sessionId) {
      try {
        const sessionId = await this.opts.getSessionId?.();
        if (sessionId && state.sessionId === sessionId) {
          await this.opts.runCommand(`/workflows rm ${runId}`);
          return true;
        }
      } catch {
        // Command failed (e.g. manager already forgot the run) — fall through
        // to plain file removal.
      }
    }
    return this.removeFiles(runId);
  }

  /**
   * Control a run via the extension's `/workflows` command. Dispatched through
   * the in-process session; the extension's own feedback (toasts/errors) arrives
   * via the normal agent-event pipeline. `retry` is not a subcommand of
   * `/workflows` (run|ui|list|watch|status|stop|pause|resume|rm|save) — reject.
   */
  async control(action: WorkflowControlAction, runId: string): Promise<void> {
    if (!validRunId(runId)) throw new Error("invalid workflow run id");
    if (action === "retry") {
      throw new Error("retry is not supported by the /workflows command — start a new run instead");
    }
    if (action !== "pause" && action !== "resume" && action !== "stop") {
      throw new Error(`unknown workflows action: ${action}`);
    }
    // The extension's manager is per-pi-process: it only holds runs started
    // by the current process. A run owned by another session can't be
    // controlled from here — fail loudly with a clear message instead of the
    // extension's confusing "Cannot stop (not running)" notify.
    const state = await this.get(runId);
    if (!state) throw new Error("workflow run not found");
    if (state.sessionId) {
      const sessionId = await this.opts.getSessionId?.();
      if (sessionId && state.sessionId !== sessionId) {
        throw new Error(
          `this run was started in another pi session — open that session to control it`
        );
      }
    }
    await this.opts.runCommand(`/workflows ${action} ${runId}`);
  }

  /** Best-effort removal of a run's files (+ sidecars) in both locations. */
  private async removeFiles(runId: string): Promise<boolean> {
    let deleted = false;
    for (const dir of await this.runsDirs()) {
      for (const name of [`${runId}.json`, `${runId}.json.bak`, `${runId}.lock`, `${runId}.tmp`]) {
        try {
          await fsp.unlink(join(dir, name));
          deleted = true;
        } catch {
          // already gone / not ours
        }
      }
    }
    return deleted;
  }
}

// ---------------------------------------------------------------------------
// Shape mapping
// ---------------------------------------------------------------------------

function toSummary(state: WorkflowRunDetail): WorkflowRunSummary {
  const { script, args, agents, logs, result, error, errorCode, pauseReason, resetHint, ...summary } = state;
  return {
    ...summary,
    agents: (agents ?? []).map((a) => ({
      id: a.id,
      label: a.label,
      status: a.status,
      phase: a.phase,
    })),
  };
}
