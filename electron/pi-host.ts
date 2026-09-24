// In-process pi host (T3-style architecture).
//
// Instead of spawning `pi --mode rpc` per session, this hosts the pi SDK
// directly in the Electron main process: one shared ModelRuntime + one shared
// resource loader + one AgentSessionRuntime. Sessions are reopened in ~1ms
// (vs ~1.3s for an RPC switch_session) because nothing is rebuilt, the loader
// and model runtime are constructed once and reused, exactly how T3 Code hosts
// the OpenCode SDK in its backend process.
//
// The event stream and IPC surface mirror the RPC protocol, so the renderer is
// unchanged: same event types (message_update, tool_execution_*, agent_start,
// extension_ui_request, ...), same command semantics.

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { projectHistory } from "./session-history";
import { ActiveRollback, RollbackStore, entryDigest, missingCheckpointReason, type Ledger, type TurnCheckpoint } from "./rollback-store";
import { validateSessionPath, contained } from "./session-path";
import { readSessionHeader } from "./session-files";
import { errorMessage, isSessionNotFound, SessionNotFoundError } from "../src/lib/errors";
import { ProjectExecutionBusyError, deriveExecutionState, type ProjectExecution } from "../src/execution";
import { SnapshotStore, isBookkeepingPath, type RestoreChange, type SnapshotCapture } from "./snapshot-store";
import { createGoalModeExtension, isExternalGoalModeExtension } from "./goal-mode/extension";
import { createDesignModeExtension } from "./design-mode/extension";
import { loadSessionGoal, saveSessionGoal, clearSessionGoal, loadGoalModeConfig } from "./goal-mode/store";
import { createDurableGoalState, defaultDurableGoalModeConfig, type GoalBeginResult } from "../src/lib/durable-goal";
import { loadDesignState, saveDesignState, clearDesignState, createDesignState, slugFor, stageOfState, type DesignStatus, type DesignState, type DesignBeginResult } from "./design-mode/store";
import type { DurableGoalState } from "../src/lib/durable-goal";
import { shouldRelayImagesThrough, toPiImages } from "./prompt-images";
import { clampToolOutput, readSessionTail, readToolOutput } from "./sessions";
import { RecapStore } from "./recap-store";
import { mergeSkillEntries, readUserSkillEntries } from "./user-skills";
import { CANVAS_PROMPT } from "../src/lib/canvas-prompt";
import { readCrops } from "../src/lib/sketch-classify";
import type { RegionReading } from "../src/lib/sketch-compile";
import type { AgentEvent, AgentModel, AgentState, CommandInfo, HistoryProjection, PromptImage, RollbackPlan, SessionStats, TurnChanges, TurnFileDiff } from "../src/bridge";
import { toAgentModel, toSessionStats, type RuntimeModelLike } from "./pi-host-shapes";
import { wireOf, wireStr } from "../src/store";
import { DEFAULT_GIT_COMMIT_MODEL, type PiSettings } from "./app-settings";
import { getSettings as defaultGetSettings, saveSettings as defaultSaveSettings } from "./app-settings";
import { buildGitCommitPrompt, extractModelText, parseGeneratedCommitMessage, type GeneratedCommitMessage } from "./git-commit-message";
import type { PreparedCommitContext } from "./git";
import { buildRecapPrompt, normalizeRecapText, pickRecapDelta, recapDue, recapWorthy, RECAP_INTERVAL_MS, type Recap } from "./recap";
import { ArchiveStore } from "./snapcompact/archive-store";
import { createSnapcompactExtension, type SnapcompactExtensionOptions } from "./snapcompact/extension";
import { ManagedSubagents, type ManagedSubagentRecord, type SubagentControlAction, type SubagentParentEvent } from "./subagents";
import { createAskQuestionTool } from "./ask-question";
import { createBabylonBashTool } from "./bash-tool";
import { createBrowserTools } from "./sim-tools";
import { createCanvasTools } from "./canvas-tools";
import type { SimController } from "./sim-controller";
import { installAgentGuards, type GuardedAgent } from "./permission-hook";
import { mapToolToAction } from "./permission-agent";
import type { AgentAction, BabylonPermissionController, Risk } from "./permissions";
import type { HookManager } from "./hook-manager";
import { ThreadManager, type ThreadEvent, type ThreadState } from "./threads";
import { flattenSessionTree, type SessionTreeRow } from "./session-tree";
import {
  AgentSessionRuntime,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionRuntimeResult,
  type CompactionResult,
  type CustomMessageEntry,
  type SessionMessageEntry,
  type ExtensionCommandContextActions,
  type ExtensionContext,
  type AgentSessionServices,
  type ExtensionError,
  type ExtensionUIDialogOptions,
  type PromptOptions,
  type ResourceLoader,
  type TerminalInputHandler,
  Theme,
  type ToolDefinition,
  type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

function messageText(message: unknown): string {
  const content = wireOf(message)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block === "string" ? block : String(wireOf(block)?.text ?? ""))).join("");
}

/** A read failed because the session file was never flushed (canonical
 *  future path of a brand-new session), not because state is corrupt. */
function isMissingFileError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (err as NodeJS.ErrnoException).code === "ENOENT" || /no such file|ENOENT/i.test(err.message);
}

function changedExclusions(
  before: SnapshotCapture["excluded"],
  after: SnapshotCapture["excluded"]
): string[] {
  const previous = new Map(before.map((item) => [item.path, item]));
  const next = new Map(after.map((item) => [item.path, item]));
  const paths = new Set([...previous.keys(), ...next.keys()]);
  return [...paths].filter((path) => {
    const a = previous.get(path);
    const b = next.get(path);
    return !a || !b || a.size !== b.size || a.mtimeMs !== b.mtimeMs;
  });
}

/** A Pi language-server diagnostic as delivered to the agent. */
export type PiDiagnostic = {
  file: string;
  line: number;
  character: number;
  severity: string;
  message: string;
  source?: string;
  code?: string | number;
};

/** Runtime narrowing for IPC payloads: diagnostics arrive from the wire. */
export function isPiDiagnostics(value: unknown): value is PiDiagnostic[] {
  return (
    Array.isArray(value) &&
    value.every((d) => {
      if (d === null || typeof d !== "object") return false;
      const v = d as Record<string, unknown>;
      return (
        typeof v.file === "string" &&
        typeof v.line === "number" &&
        typeof v.character === "number" &&
        typeof v.severity === "string" &&
        typeof v.message === "string" &&
        (v.source === undefined || typeof v.source === "string")
      );
    })
  );
}

/** Babylon-owned state outside project worktrees: rollback snapshots,
 *  rollback ledgers, recaps, and compaction archives. One canonical location
 *  for both the in-process host and the daemon, so which process owns the
 *  runtime never changes where a session's rollback history lives. */
export function defaultStateDir(agentDir?: string): string {
  return join(agentDir ?? getAgentDir(), "pideck-state");
}

/** Reasoning levels the commit/title models accept, derived from the SDK's
 *  own completeSimple signature so drift fails the build. Unknown
 *  settings-file strings (including "off", which simple completion does
 *  not accept) fall back to low. */
type SdkReasoning = NonNullable<Parameters<ModelRuntime["completeSimple"]>[2]>["reasoning"];

function asThinkingLevel(value: unknown): SdkReasoning {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return "low";
  }
}

/** SDK resource-loader entries (untyped at the SDK boundary). */
interface PromptLike {
  name: string;
  description?: string;
  argumentHint?: string;
}

interface SkillLike {
  name: string;
  description?: string;
}

/** Extension command-context option shapes, via the SDK's own interface so
 *  they stay in sync (used by commandContextActions and createSessionIn). */
type NewSessionOptions = Parameters<ExtensionCommandContextActions["newSession"]>[0];
type ForkOptions = Parameters<ExtensionCommandContextActions["fork"]>[1];
type NavigateTreeOptions = Parameters<ExtensionCommandContextActions["navigateTree"]>[1];
type SwitchSessionOptions = Parameters<ExtensionCommandContextActions["switchSession"]>[1];

/**
 * Headless TUI theme for the extension UI context. Nothing renders headless,
 * but ExtensionUIContext requires a real Theme, so this builds one with a
 * degenerate grayscale palette. The Record types make the key lists
 * self-verifying: a new SDK color key fails the build until added here.
 */
const HEADLESS_FG_KEYS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error",
  "warning", "muted", "dim", "text", "thinkingText", "userMessageText",
  "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock",
  "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
  "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment",
  "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
  "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium",
  "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
] as const;

const HEADLESS_BG_KEYS = [
  "selectedBg", "userMessageBg", "customMessageBg",
  "toolPendingBg", "toolSuccessBg", "toolErrorBg",
] as const;

function headlessTheme(): Theme {
  const fg = Object.fromEntries(HEADLESS_FG_KEYS.map((k) => [k, 7])) as Record<(typeof HEADLESS_FG_KEYS)[number], number>;
  const bg = Object.fromEntries(HEADLESS_BG_KEYS.map((k) => [k, 0])) as Record<(typeof HEADLESS_BG_KEYS)[number], number>;
  return new Theme(fg, bg, "256color", { name: "babylon-headless" });
}
/**
 * SDK services surface, re-exported under a Babylon name so call sites read
 * intent ("the services bound to this entry") instead of SDK plumbing.
 * Deliberately the full SDK type, not a Pick: narrowing here would hide
 * real capabilities from future readers.
 */
export type PiHostServices = AgentSessionServices;

export interface HostOptions {
  cwd: string;
  agentDir?: string;
  /** Babylon-owned state outside project worktrees. */
  stateDir?: string;
  /** Instance sessions root. Unset keeps the SDK default (shared legacy store). */
  sessionsRoot?: string;
  /** Execution ownership changed for a project (activate only; the renderer
   *  registry merges by generation and never navigates from this event). */
  onExecutionChanged?: (execution: ProjectExecution) => void;
  /** Called for every agent event (mirrors RPC stdout events). */
  onEvent: (event: AgentEvent) => void;
  /** Called with status changes. */
  onStatus: (status: { status: string; message?: string; cwd?: string; sessionPath?: string; requestId?: number; state?: AgentState | null }) => void;
  /**
   * Called when a session's stored cwd no longer exists. Return the replacement
   * cwd (e.g. from a folder picker), or null/undefined to abort the open.
   */
  onMissingCwd?: (sessionFile: string, storedCwd: string) => Promise<string | null | undefined>;
  /** Resolve project-local settings/extensions/skills before entering a cwd. */
  onProjectTrust?: (cwd: string) => Promise<{ trusted: boolean; remember?: boolean }>;
  /** Babylon permission system controller, if enabled. */
  permission?: BabylonPermissionController;
  /** Hook registry owner for pre/post tool use and before_stop. */
  hookManager?: HookManager;
  /** Resolve the owning task id for a session file, if any. */
  getTaskIdForSessionFile?: (sessionFile: string | null) => string | undefined;
  /** Resolve the owning bot id for a session file, if any. */
  getBotIdForSessionFile?: (sessionFile: string | null) => string | undefined;
  /** Settings provider for daemon vs Electron. */
  settingsProvider?: { getSettings(): PiSettings; saveSettings(patch: Partial<PiSettings>): PiSettings };
  /** In-app browser simulator controller for the agent browser_* tools. */
  getSimController?: () => SimController | null;
}

/** One retained session runtime. Execution belongs to the entry; the
 *  foreground pointer only decides which entry active-scoped commands
 *  (composer prompt, pickers, panels) address by default. */
export interface SessionEntry {
  runtime: AgentSessionRuntime;
  services: AgentSessionServices;
  cwd: string;
  sessionId: string;
  sessionFile: string;
  unsubscribe: (() => void) | null;
  lifecycleVersion: number;
  /**
   * Last observed disk identity of the transcript (set on creation and
   * after every sync). Activation skips the full SessionManager.open +
   * context rebuild when the fingerprint is unchanged — retained runtimes
   * stay cheap to switch back to. Null until the first successful stat
   * (unflushed new sessions have no file yet: always sync).
   */
  diskFingerprint?: DiskFingerprint | null;
}

/**
 * The single normalized project key. Every execution-retention structure
 * (executionByCwd, executionGenerationByCwd, installation checks, one-hot
 * assertions) is keyed by this, so `/repo`, `/repo/.` and lexical variants
 * can never create separate execution slots (R1/R7).
 */
export function projectKey(cwd: string): string {
  return resolve(cwd);
}

/** Cheap disk identity for change detection (stat, not parse). */
export interface DiskFingerprint {
  ino: number;
  size: number;
  mtimeMs: number;
}

/**
 * Permissive fallback controller for sessions running without the permission
 * system (tests, hook-only hosts): every action allows, approvals auto-yes.
 */
function allowAllController(): BabylonPermissionController {
  return {
    evaluate: () => ({ decision: "allow" as const }),
    requestApproval: async () => true,
    clearSessionRules: () => {},
    getMode: () => "auto" as const,
    listRules: () => [],
  };
}

import type { LocalPiHost } from "../src/local-pi-host";
export class PiHost implements LocalPiHost {
  private opts: HostOptions;
  /** Per-project model runtimes (project/cwd-bound: extension provider
   *  registrations must never leak across projects). Created lazily,
   *  creation deduplicated so concurrent opens share one build. */
  private readonly projectRuntimes = new Map<string, Promise<ModelRuntime>>();
  /** Installed top-level execution runtimes keyed by session FILE (stable
   *  identity). NOT a session cache: every entry here is the execution owner
   *  of its normalized project cwd (R1-R3), so `sessions.size` tracks
   *  executing projects, not history, tabs or views (R9). Entries leave only
   *  through an ownership transition, deactivation, or shutdown. */
  private readonly sessions = new Map<string, SessionEntry>();
  /** Set while the host is draining for restart: new turns fail fast. */
  private draining = false;
  /** Foreground pointer: renderer convenience for active-scoped commands,
   *  never an execution primitive. */
  private foregroundSessionFile: string | null = null;
  /** Per-session transition chains (open/compact/model changes serialize
   *  within a session, never across unrelated sessions). */
  private readonly transitionQueues = new Map<string, Promise<unknown>>();
  /** Services object -> live session, for closures created before the
   *  session exists (snapcompact getters run lazily per LLM call). */
  private readonly sessionForServices = new WeakMap<object, AgentSession>();
  private uiRequests = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void; sessionFile: string | null; sessionId: string | null }>();
  /** Monotonic count of AgentSession constructions. Tests use it to prove a
   *  historical view never even transiently built a runtime (R5/R9). */
  private runtimeCreations = 0;
  /** A Pi switch requested from inside a fork/switch that has not returned
   *  yet. The source must survive until then (item 45), and the transient
   *  target may not outlive it (R8). */
  private pendingHandoff: { source: SessionEntry; candidate: SessionEntry; targetFile: string; targetCwd: string } | null = null;
  /** Nesting depth of source operations (fork/clone) that can trigger a Pi
   *  switch callback; a handoff staged inside one is finalized by them. */
  private sourceOperationDepth = 0;
  private _cwd: string;
  private readonly snapshots: SnapshotStore;
  private readonly rollbacks: RollbackStore;
  private readonly recaps: RecapStore;
  private readonly recapping = new Set<string>();
  private readonly snapcompact: ArchiveStore;
  /** Project cwds whose rollback shadow index has already been warmed. */
  private readonly warmedSnapshotCwds = new Set<string>();
  /**
   * Per-file persona overlay staged for runtime creation. The old
   * setBotSystemPrompt global raced concurrent opens (open A stages A's
   * prompt, open B stages B's, A's creation reads B's). Keyed by session
   * file so each creation reads exactly its own prompt; consumed on use.
   */
  private readonly pendingSystemPrompts = new Map<string, string>();
  /** Session file → last observed message timestamp (ms). Event-driven, so the
   *  sweep never reads the session file unless a recap might be due. */
  private readonly lastMessageAt = new Map<string, number>();
  private recapTimer: ReturnType<typeof setInterval> | null = null;
  /** The session file in the foreground, if any (renderer convenience). */
  get activeSessionFile(): string | null {
    return this.foregroundSessionFile;
  }


  /**
   * Bump an entry's lifecycle counter. Strictly increasing and NOT
   * wall-clock: the release/dispose TOCTOU guard snapshots it across an
   * await, so any concurrent use of the runtime (read, prompt, view) makes
   * the release abort. Retention never orders by recency (R1/R9).
   */
  private touchEntry(entry: SessionEntry): void {
    entry.lifecycleVersion += 1;
  }

  /** Every project this host knows about — explicit, never foreground-derived
   *  (thread/subagent scans and other discovery use this set). */
  private knownProjectCwds(): Set<string> {
    const cwds = new Set<string>(this.projectRuntimes.keys());
    for (const key of this.executionByCwd.keys()) cwds.add(key);
    for (const entry of this.sessions.values()) cwds.add(entry.cwd);
    cwds.add(this._cwd);
    return cwds;
  }

  /** Retained-runtime probes (no foreground, no auto-open). */
  hasSessionRuntime(sessionFile: string): boolean {
    return this.findEntry(sessionFile) !== undefined;
  }

  sessionCwdFor(sessionFile: string): string | null {
    return this.findEntry(sessionFile)?.cwd ?? null;
  }

  isSessionStreaming(sessionFile: string): boolean {
    return this.findEntry(sessionFile)?.runtime.session.isStreaming ?? false;
  }

  // ── Execution ownership (src/execution.ts) ──────────────────────────────
  // I1: ONE top-level execution session per project. This map is the backend
  // source of truth; `foregroundSessionFile` is only a compatibility pointer
  // to the last execution activation and is NEVER an ownership fallback (I8).
  // I3: view-side calls (open/navigation) never touch these maps.
  private readonly executionByCwd = new Map<string, string>();
  private readonly executionGenerationByCwd = new Map<string, number>();

  /** The installed entry owning this project's execution slot. Derived from
   *  the slot itself (never a scan that picks an arbitrary session) and
   *  keyed by the normalized project cwd (R1/R7). */
  private entryForProject(cwd: string): SessionEntry | null {
    const file = this.executionByCwd.get(projectKey(cwd));
    return file ? this.sessions.get(file) ?? null : null;
  }

  /** Retained entry currently owning this project's execution. A mapping
   *  whose runtime is gone is invariant corruption (R3): heal it, but say so
   *  loudly so tests catch the bug instead of trusting lazy cleanup. */
  executionForCwd(cwd: string): SessionEntry | null {
    const key = projectKey(cwd);
    const file = this.executionByCwd.get(key);
    if (!file) return null;
    const entry = this.sessions.get(file);
    if (!entry) {
      console.warn(`[pideck] execution owner ${file} has no installed runtime (project ${key})`);
      this.executionByCwd.delete(key);
      return null;
    }
    return entry;
  }

  /** One definition of execution liveness (I4): everything that means the
   *  project is still being worked on. The sync half is the same set
   *  releaseSession() checks first (streaming, pending UI/approval,
   *  subagents); the async half adds compaction, threads, and workflow
   *  runs. isExecutionBusy ⊇ releaseSession, so deactivate can never
   *  release past busy work. */
  private syncExecutionBusy(entry: SessionEntry): boolean {
    if (entry.runtime.session.isStreaming) return true;
    if (entry.runtime.session.isCompacting) return true;
    if ([...this.uiRequests.values()].some((p) => p.sessionFile === entry.sessionFile)) return true;
    if (this.managedSubagents?.hasActiveForSession(entry.sessionId)) return true;
    return false;
  }

  async isExecutionBusy(entry: SessionEntry): Promise<boolean> {
    if (this.syncExecutionBusy(entry)) return true;
    if (await this.hasActiveThreadsForSession(entry.sessionId).catch(() => false)) return true;
    if (await this.hasActiveWorkflowRuns(entry.cwd, entry.sessionId)) return true;
    return false;
  }

  /** Workflow runs persist under <cwd>/.pi/workflows/runs/*.json with an
   *  owning sessionId (src/bridge.ts run-state contract). Any run the
   *  session still owns in a non-terminal state means the project works. */
  private async hasActiveWorkflowRuns(cwd: string, sessionId: string): Promise<boolean> {
    try {
      const dir = join(cwd, ".pi", "workflows", "runs");
      const files = await fsp.readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const rec = wireOf(JSON.parse(await fsp.readFile(join(dir, file), "utf8")));
          if (!rec || wireStr(rec, "sessionId") !== sessionId) continue;
          const status = wireStr(rec, "status");
          if (status === "pending" || status === "running" || status === "paused") return true;
        } catch {
          /* unparseable run file: not evidence of activity */
        }
      }
    } catch {
      /* no runs directory: nothing active */
    }
    return false;
  }

  /**
   * Acquire (or transfer) this project's execution slot — the ONE top-level
   * session allowed to execute (I1, I4):
   *   no owner           → create/resume target (or a fresh session), own it
   *   owner == target    → no-op, return the owner
   *   owner idle         → release owner safely, then resume target
   *   owner busy         → ProjectExecutionBusyError with the owner's identity
   * Never aborts the owner, never queues the target, never switches on a tab
   * click (navigation calls open(), not this), never infers from foreground.
   * Cross-project calls are independent: activating B while A1 runs is legal.
   */
  async activateExecution(
    cwd: string,
    sessionFile?: string,
    opts?: { systemPrompt?: string | null },
  ): Promise<SessionEntry> {
    if (!cwd) throw new Error("execution activation requires a project cwd");
    return this.transferExecution(sessionFile ?? null, cwd, opts);
  }

  /**
   * The ONLY path that installs a top-level runtime (R1-R3). Serialized by
   * PROJECT (not by target session) so two same-project activations inspect
   * the same state in invocation order and converge on one owner:
   *
   *   owner == target  -> same entry, no rebuild/dispose/generation bump
   *   owner busy       -> typed rejection BEFORE anything is materialized
   *   build fails      -> old owner still installed and usable
   *   owner went busy  -> detached candidate disposed, owner preserved
   *   idle transfer    -> build candidate -> release owner -> install
   *
   * The old owner is never aborted, killed, or silently dropped (I4): busy
   * always surfaces as ProjectExecutionBusyError.
   */
  private transferExecution(
    targetFile: string | null,
    cwd: string,
    opts?: { systemPrompt?: string | null; requestId?: number },
  ): Promise<SessionEntry> {
    // Claim the foregrounding sequence at invocation, BEFORE any await:
    // invocation order is intent order, so a slow cross-project build may
    // never foreground over a newer open that already committed.
    const seq = this.claimActivation();
    const key = projectKey(cwd);
    return this.enqueueTransition(`project:${key}`, async () => {
      const owner = this.entryForProject(key);
      if (owner && targetFile && owner.sessionFile === targetFile) {
        // Same-owner activation is the Send path: cheap, no rebuild, no
        // dispose, no generation bump. Compatibility presentation still runs
        // so the renderer's ready lifecycle is unchanged.
        this.touchEntry(owner);
        await this.activate(owner, { cwd: owner.cwd, seq, requestId: opts?.requestId });
        // No ownership change → no execution_changed push: the registry is
        // pushed only when a project's owner or generation actually moves.
        return owner;
      }
      // Busy gate BEFORE materialization: building a runtime for a request
      // that cannot own the project wastes memory and transiently breaks the
      // one-hot invariant.
      if (owner && (await this.isExecutionBusy(owner))) {
        throw new ProjectExecutionBusyError(owner.sessionFile, owner.sessionId);
      }
      // Detached candidate: invisible to requireEntry/executionList/Agents
      // until installExecutionEntry publishes it. A construction failure
      // leaves the previous owner completely untouched.
      const candidate = await this.materializeExecutionRuntime(targetFile, cwd, opts?.systemPrompt);
      // Recheck immediately before replacement: building is async, and the
      // old owner may have started a turn, gained an approval, or spawned a
      // child in the meantime.
      if (owner && (await this.isExecutionBusy(owner))) {
        await this.disposeDetachedEntry(candidate);
        throw new ProjectExecutionBusyError(owner.sessionFile, owner.sessionId);
      }
      if (owner && !(await this.releaseOwnerEntry(owner))) {
        await this.disposeDetachedEntry(candidate);
        throw new ProjectExecutionBusyError(owner.sessionFile, owner.sessionId);
      }
      if (owner && projectKey(owner.cwd) === key) this.executionByCwd.delete(key);
      this.installExecutionEntry(candidate);
      this.touchEntry(candidate);
      // Compatibility presentation (foreground pointer + ready status); C11
      // deletes it once the renderer stops depending on the legacy lifecycle.
      await this.activate(candidate, { cwd: candidate.cwd, seq, requestId: opts?.requestId });
      this.emitExecutionChanged(candidate.cwd);
      return candidate;
    });
  }

  /** Fire-and-forget ownership notification (activate path only): the
   *  renderer merges into executionsByCwd by generation and must never
   *  navigate from this event. Deactivation without a successor stays
   *  renderer-initiated or reconciles on the next executionList(). */
  private emitExecutionChanged(cwd: string): void {
    void this.executionSnapshot(cwd)
      .then((execution) => {
        if (execution) this.opts.onExecutionChanged?.(execution);
      })
      .catch(() => undefined);
  }

  /** Give up execution ownership for a project. False when the expected
   *  owner is gone, someone else owns it, or it went busy — never releases
   *  anything other than expectedSessionFile. */
  async deactivateExecution(cwd: string, expectedSessionFile: string): Promise<boolean> {
    const key = projectKey(cwd);
    return this.enqueueTransition(`project:${key}`, async () => {
      const owner = this.entryForProject(key);
      if (!owner || owner.sessionFile !== expectedSessionFile) {
        if (this.executionByCwd.get(key) === expectedSessionFile) this.executionByCwd.delete(key);
        return false;
      }
      if (await this.isExecutionBusy(owner)) return false;
      if (!(await this.releaseOwnerEntry(owner))) return false;
      // Cold-store the project: the transcript stays on disk, no replacement
      // runtime is created, and the generation only ever increases.
      this.executionByCwd.delete(key);
      return true;
    });
  }

  /** Current execution record for one project (renderer rebuilds its
   *  Record<cwd, ProjectExecution> from these + execution_changed events). */
  private async buildProjectExecution(cwd: string, entry: SessionEntry): Promise<ProjectExecution> {
    const streaming = entry.runtime.session.isStreaming;
    const approvalPending = [...this.uiRequests.values()].some((p) => p.sessionFile === entry.sessionFile);
    let state = deriveExecutionState({ streaming, approvalPending, waitingForInput: false, failed: false });
    if (state === "idle" && (await this.isExecutionBusy(entry))) state = "working";
    return {
      cwd,
      sessionFile: entry.sessionFile,
      sessionId: entry.sessionId,
      state,
      streaming,
      generation: this.executionGenerationByCwd.get(cwd) ?? 0,
    };
  }

  /** Backend source of truth for renderer startup/reconnect (commit 2 wires
   *  this through the transport). */
  async listProjectExecutions(): Promise<ProjectExecution[]> {
    const out: ProjectExecution[] = [];
    for (const cwd of [...this.executionByCwd.keys()]) {
      const entry = this.executionForCwd(cwd);
      if (entry) out.push(await this.buildProjectExecution(cwd, entry));
    }
    return out;
  }

  /**
   * Move this project's execution RUNTIME to a new project cwd while keeping
   *  the same session file and history (worktrees). The runtime is rebuilt
   *  under toCwd — services, resource loader, permission cwd, tool contexts
   *  and model registrations are all cwd-bound and cannot be re-pointed in
   *  place — and only then is the old one disposed. A failed rebuild leaves
   *  the source project fully intact (transactional).
   */
  async relocateExecution(sessionFile: string, fromCwd: string, toCwd: string): Promise<SessionEntry> {
    const fromKey = projectKey(fromCwd);
    const toKey = projectKey(toCwd);
    if (fromKey === toKey) {
      const owner = this.entryForProject(fromKey);
      if (!owner || owner.sessionFile !== sessionFile) throw new Error("only the project's execution session can relocate");
      return owner;
    }
    return this.enqueueTransition(`project:${toKey}`, async () => {
      const owner = this.entryForProject(fromKey);
      if (!owner || owner.sessionFile !== sessionFile) {
        throw new Error("only the project's execution session can relocate");
      }
      if (await this.isExecutionBusy(owner)) {
        throw new ProjectExecutionBusyError(owner.sessionFile, owner.sessionId);
      }
      // Build the replacement FIRST: a failure must not strand the source
      // project without a usable execution session.
      let candidate: SessionEntry;
      try {
        candidate = await this.buildSessionForCwd(sessionFile, toCwd);
      } catch (err) {
        throw new Error(`execution relocation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.disposeEntry(owner);
      this.executionByCwd.delete(fromKey);
      this.installExecutionEntry(candidate);
      this.touchEntry(candidate);
      const seq = this.claimActivation();
      await this.activate(candidate, { cwd: toCwd, seq });
      this.emitExecutionChanged(toCwd);
      return candidate;
    });
  }

  /** Current record for one project's execution slot (post-activation
   *  snapshots over the transport), or null when nothing owns it. */
  async executionSnapshot(cwd: string): Promise<ProjectExecution | null> {
    const entry = this.executionForCwd(cwd);
    return entry ? this.buildProjectExecution(cwd, entry) : null;
  }

  /**
   * Latest-wins activation ordering. Opens serialize per target file, so a
   * slow open A and a fast open B run concurrently; the foreground must
   * follow the LAST user invocation, not the last completion. Every path
   * that foregrounds claims a sequence number at invocation; only the
   * holder of the latest number may mutate foreground state.
   */
  private activationSeq = 0;

  /** Claim the activation slot for a foregrounding invocation. Call at
   *  method entry, before any await, so invocation order is intent order. */
  private claimActivation(): number {
    return ++this.activationSeq;
  }

  /** True when no newer foregrounding invocation has started since seq. */
  private isLatestActivation(seq: number): boolean {
    return seq === this.activationSeq;
  }

  /**
   * The single foreground-mutation point: pointer, cwd, rollback leaf,
   * ready emission. A superseded invocation warms its runtime but leaves
   * the foreground alone and emits nothing (the renderer already moved
   * on; a stale ready would be ignored anyway). Latest-wins is rechecked
   * AFTER the awaited preparation: checking only at entry leaves a hole
   * where a slow activation publishes a stale foreground (and a stale
   * requestId-less ready, which the renderer cannot reject) after a newer
   * activation already committed.
   */
  private async activate(
    entry: SessionEntry,
    opts: { cwd: string; requestId?: number; seq: number },
  ): Promise<AgentState> {
    if (!this.isLatestActivation(opts.seq)) return this.getStateFor(entry);
    await this.restoreRollbackLeafFor(entry.runtime.session);
    if (!this.isLatestActivation(opts.seq)) return this.getStateFor(entry);
    // Synchronous commit section: pointer, cwd, and recency flip together
    // with no await in between, so no interleaving can split them.
    this.foregroundSessionFile = entry.sessionFile;
    this._cwd = opts.cwd;
    this.touchEntry(entry);
    const state = await this.getStateFor(entry);
    if (!this.isLatestActivation(opts.seq)) return state;
    this.lastMessageAt.set(state.sessionFile ?? entry.sessionFile, Date.now());
    this.opts.onStatus({ status: "ready", cwd: opts.cwd, sessionPath: state.sessionFile ?? entry.sessionFile, requestId: opts.requestId, state });
    return state;
  }

  /** Serialize transitions per session file so unrelated sessions never wait
   *  on each other; host-wide operations use the "host" chain. */
  private enqueueTransition<T>(key: string | null | undefined, operation: () => Promise<T>): Promise<T> {
    const queueKey = key ?? "host";
    const queue = this.transitionQueues.get(queueKey) ?? Promise.resolve();
    const result = queue.then(operation, operation);
    this.transitionQueues.set(queueKey, result.catch(() => undefined));
    return result;
  }

  /** Per-project model runtime (see field docs). Creation deduplicated. */
  private ensureProjectRuntime(cwd: string): Promise<ModelRuntime> {
    const key = resolve(cwd);
    let pending = this.projectRuntimes.get(key);
    if (!pending) {
      // Catalog and credentials come from the host's agentDir, not the
      // process-wide one. Without this the agentDir option is half-honoured:
      // settings and resources follow it while the model catalog does not, so
      // an isolated host (a test, or the daemon started with
      // BABYLON_DAEMON_AGENT_DIR) still reads ~/.pi/agent/models.json from
      // whatever machine it runs on.
      const agentDir = this.opts.agentDir ?? getAgentDir();
      pending = ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      });
      this.projectRuntimes.set(key, pending);
    }
    return pending;
  }

  /** Scoped permission controller: session rules evaluate only for their
   *  owning session; approvals carry the exact session id. */
  private sessionPermission(entry: SessionEntry): BabylonPermissionController {
    const controller = this.opts.permission;
    if (!controller) return allowAllController();
    return {
      ...controller,
      evaluate: (action: AgentAction, _sessionId?: string) => controller.evaluate(action, entry.sessionId),
      requestApproval: (action: AgentAction, risk: Risk, _sessionId?: string) =>
        controller.requestApproval(action, risk, entry.sessionId),
      clearSessionRules: (sessionId?: string) => controller.clearSessionRules(sessionId ?? entry.sessionId),
      getMode: () => controller.getMode(),
      listRules: () => controller.listRules(),
    } as BabylonPermissionController;
  }

  /** Tool definitions + extension context from the OWNING session runtime.
   *  Thread control actions execute with the parent session's tools, never
   *  whatever happens to be foregrounded. Falls back to foreground only when
   *  the owner is gone (legacy behavior). */
  private getSessionTools(sessionId: string | null | undefined): {
    cwd: string;
    getToolDefinition: (name: string) => ToolDefinition | undefined;
    createContext: () => ExtensionContext;
  } {
    // Parent identity only — never "whatever is foregrounded" (I8): tool
    // definition, extension context, and permission cwd all come from the
    // owning entry.
    if (!sessionId) throw new Error("thread tool execution requires parent session identity");
    const entry = this.entryForSessionId(sessionId);
    if (!entry) throw new Error("thread parent session runtime is unavailable");
    const session = entry.runtime.session;
    return {
      cwd: entry.cwd,
      getToolDefinition: (name: string) => session.getToolDefinition(name),
      createContext: () => session.extensionRunner.createContext(),
    };
  }

  private managedSubagents!: ManagedSubagents;
  private threads!: ThreadManager;
  private trustStore!: ProjectTrustStore;
  private globalSettings!: SettingsManager;
  private readonly trustByCwd = new Map<string, boolean>();
  private createRuntimeFactory: CreateAgentSessionRuntimeFactory | null = null;
  private readonly rollbackPlans = new Map<string, {
    id: string;
    sessionId: string;
    sessionFile: string;
    targetUserEntryId: string;
    expectedLeafId: string;
    entryDigest: string;
    redo: SnapshotCapture;
    restoreMap: Record<string, string>;
    changes: RestoreChange[];
    abandonedUserEntryIds: string[];
    editorText: string;
    createdAt: number;
  }>();

  private _getSettings(): PiSettings {
    return this.opts.settingsProvider?.getSettings() ?? defaultGetSettings();
  }
  private _saveSettings(patch: Partial<PiSettings>): PiSettings {
    return this.opts.settingsProvider?.saveSettings(patch) ?? defaultSaveSettings(patch);
  }

  /** Rewire event/status sinks. The daemon attaches its broadcast here so
   *  thin clients receive live agent streaming (replaces direct opts
   *  mutation, which cannot cross the private boundary). */
  attachSinks(sinks: {
    onEvent: (event: unknown) => void;
    onStatus: HostOptions["onStatus"];
    onExecutionChanged?: (execution: ProjectExecution) => void;
  }): void {
    this.opts.onEvent = sinks.onEvent;
    this.opts.onStatus = sinks.onStatus;
    if (sinks.onExecutionChanged) this.opts.onExecutionChanged = sinks.onExecutionChanged;
  }

  /**
   * Test seams: read-only views over host internals for unit tests.
   * Production code never calls these; they exist so tests can assert
   * session bookkeeping without reaching through private fields.
   */
  testSessions(): Map<string, SessionEntry> {
    return this.sessions;
  }

  /** Ownership index, normalized-keyed, for retention assertions. */
  testExecutionByCwd(): Map<string, string> {
    return this.executionByCwd;
  }

  /**
   * Test-only steady-state assertion (R1-R3): at most one installed entry per
   * normalized project cwd, every installed entry IS its project's owner,
   * every owner resolves to exactly that entry, and no file is owned twice.
   */
  testAssertRetentionInvariant(): void {
    const byCwd = new Map<string, SessionEntry[]>();
    for (const entry of this.sessions.values()) {
      const key = projectKey(entry.cwd);
      byCwd.set(key, [...(byCwd.get(key) ?? []), entry]);
    }
    for (const [key, entries] of byCwd) {
      if (entries.length > 1) {
        throw new Error(`R1 violated: ${entries.length} installed runtimes for project ${key}`);
      }
    }
    const ownedFiles = new Set<string>();
    for (const entry of this.sessions.values()) {
      const owner = this.executionByCwd.get(projectKey(entry.cwd));
      if (owner !== entry.sessionFile) {
        throw new Error(`R2 violated: ${entry.sessionFile} is installed but ${projectKey(entry.cwd)} owns ${String(owner)}`);
      }
      if (ownedFiles.has(entry.sessionFile)) {
        throw new Error(`R2 violated: ${entry.sessionFile} is installed for two projects`);
      }
      ownedFiles.add(entry.sessionFile);
    }
    for (const [key, file] of this.executionByCwd) {
      const entry = this.sessions.get(file);
      if (!entry) throw new Error(`R3 violated: ${key} owns ${file} with no installed runtime`);
      if (projectKey(entry.cwd) !== key) {
        throw new Error(`R3 violated: ${key} owns a runtime built for ${projectKey(entry.cwd)}`);
      }
    }
  }

  /** AgentSession constructions so far (R5/R9: history must not build). */
  testRuntimeCreationCount(): number {
    return this.runtimeCreations;
  }

  testProjectRuntimes(): Map<string, Promise<ModelRuntime>> {
    return this.projectRuntimes;
  }

  testUiRequests(): Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void; sessionFile: string | null; sessionId: string | null }> {
    return this.uiRequests;
  }

  testForegroundSessionFile(): string | null {
    return this.foregroundSessionFile;
  }

  /** Drive the ownership-scoped recap sweep deterministically (the timer
   *  path is too slow/brittle for tests). */
  testSweepRecap(): Promise<void> {
    return this.sweepRecap();
  }

  constructor(opts: HostOptions) {
    this.opts = opts;
    this._cwd = opts.cwd;
    const stateDir = opts.stateDir ?? defaultStateDir(opts.agentDir);
    this.snapshots = new SnapshotStore(join(stateDir, "snapshots"));
    this.rollbacks = new RollbackStore(join(stateDir, "rollbacks"));
    this.recaps = new RecapStore(join(stateDir, "recaps"));
    this.snapcompact = new ArchiveStore({ stateDir });
    // Auto-recap: after a quiet period in the active chat, summarize the
    // stretch since the previous recap with a cheap model. The tick is bounded
    // by the recap interval (min 2s) so PIDECK_RECAP_MS fast-forward works for
    // verification.
    const intervalMs = Number(process.env.PIDECK_RECAP_MS) || RECAP_INTERVAL_MS;
    this.recapTimer = setInterval(
      () => void this.sweepRecap(),
      Math.min(30_000, Math.max(2_000, Math.round(intervalMs / 2)))
    );
    this.recapTimer.unref?.();
  }

  /** One-time boot: managers plus a warm model runtime for the default
   *  project. Sessions are created lazily per open and retained. */
  async start(): Promise<void> {
    const agentDir = this.opts.agentDir ?? getAgentDir();
    const cwd = resolve(this.opts.cwd);
    this.managedSubagents = new ManagedSubagents({
      agentDir,
      modelRuntime: await this.ensureProjectRuntime(cwd),
      getModelRuntime: (forCwd: string) => this.ensureProjectRuntime(forCwd),
      onUpdate: () => this.opts.onEvent({ type: "pideck_subagents_changed" }),
      onParentMessage: (record, action, message) => this.notifySubagentParent(record, action, message),
      permission: this.opts.permission,
      hookManager: this.opts.hookManager,
      onLaunch: (ev) => this.opts.onEvent({ ...ev }),
    });
    this.threads = new ThreadManager({
      runTool: async (toolName, args, sessionId?: string | null) => {
        const tools = this.getSessionTools(sessionId);
        // Threads execute tools directly (bypassing the agent loop's
        // beforeToolCall hook), so gate them here against the same policy.
        if (this.opts.permission) {
          const action = mapToolToAction(toolName, args, tools.cwd);
          if (action) {
            const result = this.opts.permission.evaluate(action, sessionId ?? undefined);
            if (result.decision === "deny") {
              throw new Error(result.reason ?? "Blocked by Babylon permission policy");
            }
            if (result.decision === "ask") {
              const allowed = await this.opts.permission.requestApproval(action, result.risk ?? "uncertain", sessionId ?? undefined);
              if (!allowed) throw new Error("Denied by user approval");
            }
          }
        }
        const tool = tools.getToolDefinition(toolName);
        if (!tool) throw new Error("Threads extension is not available in this session");
        return tool.execute(
          `babylon-thread-${randomUUID()}`,
          args,
          undefined,
          undefined,
          tools.createContext()
        );
      },
      onParentMessage: (thread, action, message) => this.notifyThreadParent(thread, action, message),
    });
    const trustStore = new ProjectTrustStore(agentDir);
    this.trustStore = trustStore;
    const globalSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    this.globalSettings = globalSettings;
    const trustByCwd = this.trustByCwd;

    const createRuntime: CreateAgentSessionRuntimeFactory = async (input) => {
      const runtimeCwd = resolve(input.cwd);
      const needsTrust = hasTrustRequiringProjectResources(runtimeCwd);
      const savedTrust = trustStore.get(runtimeCwd);
      let projectTrusted = trustByCwd.get(runtimeCwd);
      if (projectTrusted === undefined) {
        if (!needsTrust) projectTrusted = true;
        else if (savedTrust !== null) projectTrusted = savedTrust;
        else if (globalSettings.getDefaultProjectTrust() === "always") projectTrusted = true;
        else if (globalSettings.getDefaultProjectTrust() === "never") projectTrusted = false;
        else if (input.sessionStartEvent !== undefined && this.opts.onProjectTrust) {
          const decision = await this.opts.onProjectTrust(runtimeCwd);
          projectTrusted = decision.trusted;
          if (decision.remember) trustStore.set(runtimeCwd, decision.trusted);
        } else {
          // Invisible warm runtime: load trusted global resources only and defer
          // the question until the user actually opens this project.
          projectTrusted = false;
        }
        if (input.sessionStartEvent !== undefined || !needsTrust || savedTrust !== null) {
          trustByCwd.set(runtimeCwd, projectTrusted);
        }
      }

      // Settings, resources, extensions, skills, templates, tools and context are
      // cwd-bound: every session gets fresh services so project A can never
      // leak into project B and extension contexts never go stale. Only the
      // per-project ModelRuntime is shared (extension provider registrations
      // must stay within their project).
      const settingsManager = SettingsManager.create(runtimeCwd, agentDir, { projectTrusted });
      const modelRuntime = await this.ensureProjectRuntime(runtimeCwd);
      const self = this;
      // Persona overlay for THIS creation only, resolved from the pending
      // map by session file (never a host global): concurrent creations
      // each read their own prompt. Stable per bot so provider
      // prefix-caching is preserved within a bot's sessions.
      const createdFile = input.sessionManager.getSessionFile() ?? null;
      const overlay = createdFile ? (self.pendingSystemPrompts.get(createdFile) ?? null) : null;
      const services = await createAgentSessionServices({
        cwd: runtimeCwd,
        agentDir,
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          appendSystemPrompt: [...(overlay ? [overlay] : []), CANVAS_PROMPT],
          extensionsOverride: (base) => ({
            ...base,
            extensions: [
              // An external goal-mode copy would double-inject the system
              // prompt and double-dispatch follow-ups next to the hardbaked
              // one below. Drop it from Babylon sessions only; CLI sessions
              // keep loading whatever the user installed.
              ...base.extensions.filter((ext) => !isExternalGoalModeExtension(ext)),
              createSnapcompactExtension({
                archiveStore: this.snapcompact,
                getMode: () => (this.opts.settingsProvider?.getSettings() ?? defaultGetSettings()).compaction?.mode ?? "summary",
                // The owning session is registered after creation (getters run
                // lazily per LLM call); fall back to foreground only for
                // sessions created before this mapping existed.
                getModel: () => {
                  const s = self.sessionForServices.get(services as object);
                  if (!s) console.warn("[pideck] snapcompact owner session missing (skipping model pin)");
                  const m = s?.model;
                  if (!m) return null;
                  return { provider: m.provider, id: m.id, input: m.input };
                },
                getSessionId: () => self.sessionForServices.get(services as object)?.sessionId ?? "",
                getSessionFile: () => self.sessionForServices.get(services as object)?.sessionFile ?? null,
              } as SnapcompactExtensionOptions),
              createGoalModeExtension({
                getCwd: () => runtimeCwd,
                getSessionId: () => {
                  const id = self.sessionForServices.get(services as object)?.sessionId ?? "";
                  return id || null;
                },
                isProjectTrusted: () => projectTrusted ?? false,
                sendFollowUp: (text: string) => {
                  // Owner-mapped only: a lost mapping SKIPS the follow-up —
                  // it must never fall through to another session (I8).
                  const session = self.sessionForServices.get(services as object);
                  if (!session) {
                    console.warn("[pideck] goal follow-up missing owning session");
                    return;
                  }
                  void session.sendUserMessage(text, { deliverAs: "followUp" }).catch((err: unknown) =>
                    console.warn("[pideck] goal follow-up failed:", err instanceof Error ? err.message : err)
                  );
                },
              }),
              createDesignModeExtension({
                getCwd: () => runtimeCwd,
                getSessionId: () => {
                  const id = self.sessionForServices.get(services as object)?.sessionId ?? "";
                  return id || null;
                },
                sendFollowUp: (text: string) => {
                  // Owner-mapped only (same contract as goal follow-ups).
                  const session = self.sessionForServices.get(services as object);
                  if (!session) {
                    console.warn("[pideck] design follow-up missing owning session");
                    return;
                  }
                  void session.sendUserMessage(text, { deliverAs: "followUp" }).catch((err: unknown) =>
                    console.warn("[pideck] design follow-up failed:", err instanceof Error ? err.message : err)
                  );
                },
              }),
            ],
          }),
        },
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager: input.sessionManager,
        sessionStartEvent: input.sessionStartEvent,
        customTools: [this.managedSubagents.tool(), createAskQuestionTool(), createBabylonBashTool(runtimeCwd), ...createBrowserTools(() => self.opts.getSimController?.() ?? null), ...createCanvasTools()],
      });
      const out: CreateAgentSessionRuntimeResult = {
        session: result.session,
        services,
        extensionsResult: result.extensionsResult,
        diagnostics: services.diagnostics ?? [],
        modelFallbackMessage: result.modelFallbackMessage,
      };
      return out;
    };
    this.createRuntimeFactory = createRuntime;

    // Warm the default project's model runtime so the first open pays no
    // catalogue build. No session is created here: sessions are built lazily
    // per open and retained independently afterwards.
    await this.ensureProjectRuntime(cwd);
    // Warm but invisible, the user hasn't opened a session yet.
    console.log("[pideck] pi host ready (in-process)");
  }

  /**
   * Materialize a CANDIDATE execution runtime for sessionFile (or a fresh
   * session when null). This is NOT a general session cache: the returned
   * entry is construction state until installExecutionEntry() publishes it —
   * requireEntry, executionList, and the Agents tree cannot see it before
   * then. Concurrent builds for the same file share one construction.
   */
  private readonly creatingCandidates = new Map<string, Promise<SessionEntry>>();
  private async materializeExecutionRuntime(
    sessionFile: string | null,
    cwd: string,
    systemPrompt?: string | null,
  ): Promise<SessionEntry> {
    if (!sessionFile) {
      // Fresh session: the file path is known deterministically (reading the
      // foreground pointer back would be an ownership fallback, I8).
      const sm = SessionManager.create(cwd, this.opts.sessionsRoot);
      const file = sm.getSessionFile()!;
      if (systemPrompt) this.pendingSystemPrompts.set(file, systemPrompt);
      return this.buildSessionEntry(file, cwd, sm);
    }
    const existing = this.sessions.get(sessionFile);
    if (existing) return existing;
    let pending = this.creatingCandidates.get(sessionFile);
    if (!pending) {
      pending = this.buildSessionFromFile(sessionFile, cwd, systemPrompt).finally(() => {
        if (this.creatingCandidates.get(sessionFile) === pending) this.creatingCandidates.delete(sessionFile);
      });
      this.creatingCandidates.set(sessionFile, pending);
    }
    return pending;
  }

  private async buildSessionFromFile(
    sessionFile: string,
    cwd: string,
    systemPrompt?: string | null,
  ): Promise<SessionEntry> {
    if (systemPrompt) this.pendingSystemPrompts.set(sessionFile, systemPrompt);
    try {
      return await this.buildSessionForCwd(sessionFile, cwd);
    } catch (err) {
      // The session's stored cwd doesn't exist (project moved/deleted).
      // Ask for a new location and retry with the override, mirroring pi's
      // interactive-mode prompt. The failed candidate never installed.
      if (this.isMissingCwdError(err) && this.opts.onMissingCwd) {
        const replacement = await this.opts.onMissingCwd(sessionFile, cwd);
        if (replacement) return this.buildSessionForCwd(sessionFile, replacement);
      }
      throw err;
    }
  }

  private async buildSessionForCwd(sessionFile: string, cwd: string): Promise<SessionEntry> {
    // Fingerprint BEFORE the read: an external append landing during the
    // async runtime build must not be recorded as ingested (same race as
    // the retained-sync path — fail toward a redundant reparse, never a
    // permanently skipped append).
    const preRead = await this.fingerprintSessionFile(sessionFile);
    const sessionManager = SessionManager.open(sessionFile, undefined, cwd);
    return this.buildSessionEntry(sessionFile, cwd, sessionManager, preRead);
  }

  /** Builds one DETACHED entry: runtime, services, bindings and subscription,
   *  but no map entry. installExecutionEntry() publishes it as an owner. */
  private async buildSessionEntry(sessionFile: string, cwd: string, sessionManager: SessionManager, preReadFingerprint?: DiskFingerprint | null): Promise<SessionEntry> {
    const factory = this.createRuntimeFactory;
    if (!factory) throw new Error("pi host not started");
    let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
    try {
      runtime = await createAgentSessionRuntime(factory, {
        cwd,
        agentDir: this.opts.agentDir ?? getAgentDir(),
        sessionManager,
      });
    } finally {
      // Consumed by the factory above (or failed before use): never leak a
      // stale overlay into a later creation for the same file.
      this.pendingSystemPrompts.delete(sessionFile);
    }
    // The SDK keeps the built services on the runtime object; register them
    // so lazily-evaluated closures (snapcompact getters) resolve the owning
    // session instead of whatever happens to be foregrounded.
    const services = runtime.services;
    const entry: SessionEntry = {
      runtime,
      services,
      cwd,
      sessionId: runtime.session.sessionId,
      sessionFile,
      unsubscribe: null,
      lifecycleVersion: 0,
    };
    if (services && typeof services === "object") this.sessionForServices.set(services, runtime.session);
    this.runtimeCreations += 1;
    runtime.setBeforeSessionInvalidate(() => {
      entry.unsubscribe?.();
      entry.unsubscribe = null;
      this.rejectSessionUi(entry, new Error("session replaced"));
    });
    runtime.setRebindSession((session) => this.bindSession(session, entry));
    await this.bindSession(runtime.session, entry);
    // Build this project's rollback shadow index now, not on the first send.
    // The first authoritative capture on a large worktree hashes the whole
    // tree, and `prompt()` cannot call the model until it finishes. Warming at
    // open overlaps that cost with the user reading and typing.
    this.warmSnapshots(cwd);
    // Seed from the pre-read fingerprint (or null for fresh sessions whose
    // file does not exist yet): the first activation with a present file
    // syncs once and seeds then. Never stat here — a post-build stat would
    // record an append that raced the build as ingested.
    entry.diskFingerprint = preReadFingerprint ?? null;
    return entry;
  }

  /** Publish a detached candidate as its project's execution owner (R1-R3).
   *  One coherent commit: the runtime map and the ownership index move
   *  together, and the per-project generation only ever increases. */
  private installExecutionEntry(entry: SessionEntry): void {
    const key = projectKey(entry.cwd);
    this.sessions.set(entry.sessionFile, entry);
    this.executionByCwd.set(key, entry.sessionFile);
    this.executionGenerationByCwd.set(key, (this.executionGenerationByCwd.get(key) ?? 0) + 1);
  }

  /** Full disposal of an entry that is installed or detached: unsubscribe,
   *  reject its pending UI, dispose the SDK session, drop permission rules
   *  and the services mapping, and forget it. */
  private disposeEntry(entry: SessionEntry): void {
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    this.rejectSessionUi(entry, new Error("session released"));
    const live = entry.runtime.session;
    try {
      live.dispose();
    } catch {
      /* ignore */
    }
    try {
      this.opts.permission?.clearSessionRules(live.sessionId);
    } catch {
      /* ignore */
    }
    // A disposed session's extension callbacks (goal/design/snapcompact) must
    // not be able to reach the NEXT owner through a stale mapping.
    if (entry.services && typeof entry.services === "object") this.sessionForServices.delete(entry.services);
    this.sessions.delete(entry.sessionFile);
    if (this.foregroundSessionFile === entry.sessionFile) this.foregroundSessionFile = null;
  }

  /** Dispose a candidate that never became an owner. No candidate survives a
   *  failed, cancelled, or rejected activation. */
  private async disposeDetachedEntry(entry: SessionEntry): Promise<void> {
    this.disposeEntry(entry);
  }

  /** Fire-and-forget warm of a cwd's rollback shadow index. Failures are
   *  ignored: the turn-start capture stays authoritative and would simply pay
   *  the cost instead. */
  private warmSnapshots(cwd: string): void {
    const key = resolve(cwd);
    if (this.warmedSnapshotCwds.has(key)) return;
    this.warmedSnapshotCwds.add(key);
    void this.snapshots.capture(cwd, { authoritative: true }).catch(() => {
      // Let a later open retry after a transient failure.
      this.warmedSnapshotCwds.delete(key);
    });
  }

  /** Reject only one session's pending extension-UI promises (release or
   *  invalidation must never touch another session's dialogs). */
  private rejectSessionUi(entry: SessionEntry, error: Error): void {
    for (const [id, pending] of this.uiRequests) {
      if (pending.sessionFile !== entry.sessionFile) continue;
      this.uiRequests.delete(id);
      this.opts.onEvent({ type: "extension_ui_cancel", id });
      pending.reject(error);
    }
  }

  private async bindSession(session: AgentSession, entry: SessionEntry): Promise<void> {
    // Extension UI context: dialogs emit extension_ui_request events and await
    // a response (mirrors RPC's extension_ui_request/response protocol).
    // Every request carries its OWNING session identity (never the foreground
    // session): concurrent sessions awaiting input stay distinguishable and
    // responses route by dialog id regardless of what is on screen.
    const dialog = <T,>(request: Record<string, unknown>, pick: (r: unknown) => T, opts?: ExtensionUIDialogOptions): Promise<T> =>
      new Promise((resolveDialog, rejectDialog) => {
        const id = `ui-${crypto.randomUUID()}`;
        let timeout: NodeJS.Timeout | undefined;
        const finish = (response: unknown) => {
          if (timeout) clearTimeout(timeout);
          resolveDialog(pick(response));
        };
        const reject = (error: Error) => {
          if (timeout) clearTimeout(timeout);
          rejectDialog(error);
        };
        this.uiRequests.set(id, { resolve: finish, reject, sessionFile: session.sessionFile ?? null, sessionId: entry.sessionId });
        this.opts.onEvent({ type: "extension_ui_request", id, ...request, timeout: opts?.timeout, sessionId: session.sessionId, sessionFile: session.sessionFile ?? null });
        const timeoutMs = opts?.timeout;
        if (typeof timeoutMs === "number" && timeoutMs > 0) {
          timeout = setTimeout(() => {
            if (!this.uiRequests.delete(id)) return;
            this.opts.onEvent({ type: "extension_ui_cancel", id });
            finish({ cancelled: true });
          }, timeoutMs);
        }
        if (opts?.signal) {
          const abort = () => {
            if (!this.uiRequests.delete(id)) return;
            this.opts.onEvent({ type: "extension_ui_cancel", id });
            finish({ cancelled: true });
          };
          if (opts.signal.aborted) abort();
          else opts.signal.addEventListener("abort", abort, { once: true });
        }
      });

    const uiContext = {
      mode: "rpc",
      hasUI: true,
      select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
        dialog({ method: "select", title, options }, (r) => {
          const w = wireOf(r);
          if (!w || w.cancelled) return undefined;
          return typeof w.value === "string" ? w.value : undefined;
        }, opts),
      confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
        dialog({ method: "confirm", title, message }, (r) => !!wireOf(r)?.confirmed, opts),
      input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
        dialog({ method: "input", title, placeholder }, (r) => {
          const w = wireOf(r);
          if (!w || w.cancelled) return undefined;
          return typeof w.value === "string" ? w.value : undefined;
        }, opts),
      editor: (title: string, prefill?: string, opts?: ExtensionUIDialogOptions) =>
        dialog({ method: "editor", title, prefill }, (r) => {
          const w = wireOf(r);
          if (!w || w.cancelled) return undefined;
          return typeof w.value === "string" ? w.value : undefined;
        }, opts),
      notify: (message: string, type?: "info" | "warning" | "error") => {
        this.opts.onEvent({
          type: "extension_ui_request",
          id: `notify-${crypto.randomUUID()}`,
          method: "notify",
          message,
          notifyType: type ?? "info",
        });
        return Promise.resolve();
      },
      // Headless host: no TUI surface, so interactive-only members are
      // explicit no-ops (matching the setStatus/setWidget stubs below).
      onTerminalInput: (_handler: TerminalInputHandler) => () => {},
      setStatus: (_key: string, _text: string | undefined) => {},
      setWorkingVisible: (_visible: boolean) => {},
      setWorkingIndicator: (_options?: WorkingIndicatorOptions) => {},
      setHiddenThinkingLabel: (_label?: string) => {},
      pasteToEditor: (_text: string) => {},
      setWidget: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      setEditorText: (_text: string) => {},
      set_editor_text: () => Promise.resolve(),
      setWorkingMessage: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setEditorComponent: () => {},
      addAutocompleteProvider: () => {},
      getEditorComponent: () => undefined,
      getToolsExpanded: () => false,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false as const, error: "not supported" }),
      setToolsExpanded: () => {},
      getEditorText: () => "",
      theme: headlessTheme(),
      custom: () => Promise.reject(new Error("custom components unavailable in headless mode")),
    };

    await session.bindExtensions({
      uiContext,
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        // Created without disturbing the foreground: agent-requested sessions
        // appear in the session list; only explicit user opens foreground.
        // The SDK's newSession contract reports {cancelled}: creation here
        // never cancels (failures reject instead), matching the previous
        // runtime behavior where the returned state carried no cancelled flag.
        newSession: async (options?: NewSessionOptions) => {
          await this.createSessionIn(entry.cwd, options);
          return { cancelled: false };
        },
        fork: async (entryId: string, forkOptions?: ForkOptions) => {
          const sourceSessionId = session.sessionId;
          const r = await entry.runtime.fork(entryId, forkOptions);
          if (!r.cancelled) await this.rollbacks.clearActive(sourceSessionId).catch(() => undefined);
          return { cancelled: r.cancelled };
        },
        navigateTree: async (targetId: string, options?: NavigateTreeOptions) => {
          const sourceSessionId = session.sessionId;
          const previousLeaf = session.sessionManager.getLeafId();
          const r = await session.navigateTree(targetId, options);
          if (!r.cancelled && session.sessionManager.getLeafId() !== previousLeaf) {
            await this.rollbacks.clearActive(sourceSessionId).catch(() => undefined);
          }
          return { cancelled: r.cancelled };
        },
        // Extension/Pi-requested "switch" is an EXECUTION HANDOFF, not
        // foregrounding: the target becomes this project's owner and the
        // source goes cold. Never dispose the source from inside this
        // callback — it may be the very runtime performing the fork.
        switchSession: async (sessionPath: string, options?: SwitchSessionOptions) => {
          await this.stageHandoff(sessionPath, options);
          return { cancelled: false };
        },
        reload: async () => {
          await session.reload();
        },
      },
      shutdownHandler: () => {},
      onError: (err: ExtensionError) => {
        const msg = err?.error ?? String(err);
        // Lifecycle noise: extension async init (e.g. MCP server startup) that
        // was still in flight when the session was replaced hits pi's stale-ctx
        // guard. The extension self-heals via its own generation guard, so this
        // is expected during fast session switches, don't surface it as an
        // error toast.
        if (typeof msg === "string" && msg.includes("extension ctx is stale")) return;
        this.opts.onEvent({ type: "extension_error", extensionPath: err?.extensionPath, event: err?.event, error: msg });
      },
    });
    entry.unsubscribe?.();
    if (this.opts.permission) {
      installAgentGuards(session.agent as GuardedAgent, {
        controller: this.sessionPermission(entry),
        cwd: entry.cwd,
        hookManager: this.opts.hookManager,
        sessionId: session.sessionId,
        taskId: this.opts.getTaskIdForSessionFile?.(session.sessionFile ?? null),
      });
    } else if (this.opts.hookManager) {
      installAgentGuards(session.agent as GuardedAgent, {
        controller: allowAllController(),
        cwd: entry.cwd,
        hookManager: this.opts.hookManager,
        sessionId: session.sessionId,
        taskId: this.opts.getTaskIdForSessionFile?.(session.sessionFile ?? null),
      });
    }

    entry.unsubscribe = session.subscribe((event) => {
      this.opts.onEvent({ ...event, sessionId: session.sessionId, sessionFile: session.sessionFile });
      if (event.type === "tool_execution_end" && (event.toolName === "spawn_thread" || event.toolName === "workflow")) {
        // Tool results are model-adjacent data: narrow every field instead
        // of trusting the wire shape.
        const details = wireOf(wireOf(event.result)?.details) ?? {};
        const runId = wireStr(details, "threadId") ?? wireStr(details, "runId") ?? event.toolCallId;
        if (runId) {
          const status = event.isError ? "failed" : "running";
          const args = wireOf(wireOf(event)?.args);
          const label = wireStr(args, "name")?.trim() || wireStr(args, "goal")?.trim()?.slice(0, 80) || wireStr(details, "threadId") || wireStr(details, "runId") || event.toolName;
          this.opts.onEvent({ type: "babylon_launch_started", runId, runKind: event.toolName === "spawn_thread" ? "thread" : "workflow", label, status: "running", sessionId: session.sessionId, sessionFile: session.sessionFile });
          if (status === "failed") this.opts.onEvent({ type: "babylon_launch_terminated", runId, status: "failed", sessionId: session.sessionId, sessionFile: session.sessionFile });
        }
      }
      if (event.type === "tool_execution_end") {
        // args/toolCall ride the wire beyond the SDK's typed surface.
        const wired = wireOf(event);
        const toolName = event.toolName ?? wireStr(wireOf(wired?.toolCall), "name") ?? "";
        void this.opts.hookManager?.dispatch(
          "post_tool_use",
          {
            toolName,
            args: wired?.args ?? event.result,
            sessionId: session.sessionId,
            taskId: this.opts.getTaskIdForSessionFile?.(session.sessionFile ?? null),
          },
          async () => ({})
        );
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        void this.relayPromotedSubagentReply(session, messageText(event.message));
      }
      if (event.type === "message_end" && event.message?.role === "user" && !session.sessionManager.getSessionName()) {
        void this.suggestSessionName(session, event.message);
      }
      if (event.type === "message_end" && event.message) {
        const ts = event.message.timestamp;
        this.lastMessageAt.set(
          session.sessionFile ?? session.sessionId,
          typeof ts === "number" ? ts : Date.parse(ts ?? "") || Date.now()
        );
      }
    });
  }

  // One-shot, non-blocking session naming: after the first user message in a
  // session without a display name, ask a cheap model for a short title and
  // persist it via a session_info entry, so the sidebar shows a real name
  // instead of the raw prompt.
  private sessionNaming = new Set<string>();
  private async suggestSessionName(session: AgentSession, currentMessage?: unknown): Promise<void> {
    const sessionId = session.sessionId;
    if (this.sessionNaming.has(sessionId)) return;
    this.sessionNaming.add(sessionId);
    try {
      // Under pi >= 0.84.2 the in-memory manager keeps message content out of
      // getEntries(), so the sample is read from the append-only file. The
      // triggering message is included explicitly: persistence happens after
      // subscriber notification, so the file can lag one message behind.
      const file = session.sessionFile ?? session.sessionManager.getSessionFile();
      const { messages } = file ? await readSessionTail(file) : { messages: [] };
      const userTexts = messages
        .filter((m) => wireOf(m)?.role === "user")
        .map((m) => messageText(m))
        .filter((t: string) => t.trim().length > 0);
      const currentText =
        wireOf(currentMessage)?.role === "user" ? messageText(currentMessage).trim() : "";
      if (currentText) userTexts.push(currentText);
      const sample = userTexts.slice(-4).join("\n").slice(0, 1500);
      if (!sample.trim()) return;
      const namingCwd = session.sessionManager.getCwd?.();
      if (!namingCwd) return;
      const title = await this.generateSessionTitle(sample, namingCwd);
      if (!title || session.sessionManager.getSessionName()) return;
      session.sessionManager.appendSessionInfo(title);
      this.opts.onEvent({ type: "pideck_sessions_changed" });
    } catch {
      // Naming is best-effort; the prompt remains the fallback title.
    } finally {
      this.sessionNaming.delete(sessionId);
    }
  }

  private async generateSessionTitle(sample: string, cwd: string): Promise<string | null> {
    const prompt =
      "You are naming a coding-agent conversation. Reply with ONLY a short title (3-6 words, no quotes, no period) that captures the intent of this conversation:\n\n" +
      sample;
    const text = await this.askCheap(prompt, 1024, { cwd });
    if (!text) return null;
    return text.replace(/^["'""]+|["'""]+$/g, "").slice(0, 60);
  }

  async generateGitCommitMessage(context: PreparedCommitContext): Promise<GeneratedCommitMessage> {
    const settings = this._getSettings();
    const ref = settings.gitCommitModel ?? DEFAULT_GIT_COMMIT_MODEL;
    const commitCwd = (context as { cwd?: string }).cwd;
    if (!commitCwd) throw new Error("commit context is missing a project cwd");
    const modelRuntimeForCommit = await this.modelRuntimeForCwd(commitCwd);
    const model = modelRuntimeForCommit.getModel(ref.provider, ref.modelId);
    if (!model) {
      throw new Error(
        `Commit model is unavailable: ${ref.provider}/${ref.modelId}. ` +
          `Select an installed model in Settings → Pi → Git commit model.`
      );
    }
    if (context.fileCount === 0) throw new Error("No staged files to describe, commit context is empty");
    if (context.stagedPatch.trim().length === 0 && context.stagedSummary.trim().length === 0) {
      throw new Error("Staged patch is empty, nothing to commit");
    }

    const complete = (prompt: string) =>
      modelRuntimeForCommit.completeSimple(
        model,
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        { reasoning: "low", maxTokens: 4_096 }
      );
    const read = async (prompt: string): Promise<string> => {
      let response: Awaited<ReturnType<typeof complete>>;
      try {
        response = await complete(prompt);
      } catch (cause) {
        throw new Error(`commit model request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage?.trim() || "commit model failed");
      }
      const text = extractModelText(response);
      if (!text) throw new Error(`commit model returned no text (stop reason: ${response.stopReason})`);
      return text;
    };

    const first = await read(buildGitCommitPrompt(context, settings.gitCommitPrompt ?? ""));
    try {
      return parseGeneratedCommitMessage(first, context.requiresBody);
    } catch (cause) {
      const correction = cause instanceof Error ? cause.message : String(cause);
      const retry = await read(buildGitCommitPrompt(context, settings.gitCommitPrompt ?? "", correction));
      try {
        return parseGeneratedCommitMessage(retry, context.requiresBody);
      } catch (retryCause) {
        const detail = retryCause instanceof Error ? retryCause.message : String(retryCause);
        throw new Error(`commit message still invalid after retry: ${detail} (first error: ${correction})`);
      }
    }
  }

  /** One cheap model call shared by naming and recaps. The model + reasoning
   *  level are configurable (Settings → Pi → Title generation), falling back
   *  to the previous hardcoded cheap model when unset. */
  private async askCheap(
    prompt: string,
    maxTokens: number,
    opts: { cwd: string; fallbackModel?: AgentSession["model"] }
  ): Promise<string | null> {
    const settings = this._getSettings();
    const modelRuntime = await this.modelRuntimeForCwd(opts.cwd);
    const titleModel = settings.titleModel
      ? modelRuntime.getModel(settings.titleModel.provider, settings.titleModel.modelId)
      : undefined;
    // Explicit caller-provided fallback last — never the foreground model.
    const model =
      titleModel ??
      modelRuntime.getModel("opencode-go", "muse-spark-1.2-contributor") ??
      (opts.fallbackModel ?? null);
    if (!model) return null;
    const reasoning = asThinkingLevel(settings.titleReasoning);
    const effectiveMaxTokens = reasoning === "low" ? Math.max(maxTokens, 1024) : maxTokens;
    try {
      const response = await modelRuntime.completeSimple(
        model,
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        { reasoning, maxTokens: effectiveMaxTokens }
      );
      const text = (response?.content ?? [])
        .map((block) => (block?.type === "text" ? block.text ?? "" : ""))
        .join("")
        .trim();
      if (text) return text;
      if (response?.stopReason === "length") {
        const retry = await modelRuntime.completeSimple(
          model,
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
          { reasoning: "minimal", maxTokens: Math.max(effectiveMaxTokens, 1024) }
        );
        return (retry?.content ?? [])
          .map((block) => (block?.type === "text" ? block.text ?? "" : ""))
          .join("")
          .trim() || null;
      }
      return null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Auto-recap: after a quiet period in a chat, summarize the stretch since
  // the last recap with the same cheap model. The recap is a Babylon-owned
  // annotation (never written into the append-only session file) rendered as a
  // "Recap: …" system line; getRecaps merges it into transcript windows.
  // -------------------------------------------------------------------------

  async getRecaps(sessionFile: string): Promise<Recap[]> {
    return this.recaps.recapsFor(sessionFile);
  }

  private async sweepRecap(): Promise<void> {
    // Recap follows EXECUTION OWNERS, never the foreground: quiet Project A
    // recaps while B runs (and while B happens to be viewed).
    for (const [, ownerFile] of this.executionByCwd) {
      const entry = this.sessions.get(ownerFile);
      if (!entry) continue;
      // One busy child still means the project is working: no recap there
      // (isExecutionBusy covers streaming, compaction, approvals, subagents,
      // threads, and workflows for THIS owner only).
      if (await this.isExecutionBusy(entry)) continue;
      const session = entry.runtime.session;
      const file = session.sessionFile ?? ownerFile;
      const intervalMs = Number(process.env.PIDECK_RECAP_MS) || RECAP_INTERVAL_MS;
      const cached = this.lastMessageAt.get(file);
      if (!cached || Date.now() - cached < intervalMs) continue;
      // Recap timing is not context pressure. Snapcompact is driven by
      // Pi's real compaction boundary inside the snapcompact extension.
      await this.maybeRecap(entry);
    }
  }

  private async maybeRecap(entry: SessionEntry): Promise<void> {
    const session = entry.runtime.session;
    const file = session.sessionFile ?? entry.sessionFile;
    if (this.recapping.has(file)) return;
    if (session.isStreaming) return;
    if (this.managedSubagents?.hasAnyActive()) return;
    if (this.managedSubagents?.hasActiveForSession(session.sessionId)) return;
    if (await this.isExecutionBusy(entry)) return;
    this.recapping.add(file);
    try {
      // The in-memory session manager keeps message content out of getEntries()
      // for large sessions, so the delta is read from the append-only file ,
      // the same projection the transcript uses, with entryIds attached.
      const { messages } = await readSessionTail(file);
      if (!messages.length) return;
      const lastMessageAt = messages.reduce<number>((max, m) => {
        const ts = wireOf(m)?.timestamp;
        return Math.max(max, typeof ts === "number" ? ts : 0);
      }, 0);
      if (!lastMessageAt) return;
      const recaps = await this.recaps.recapsFor(file);
      const lastRecapAt = recaps.reduce((max, r) => Math.max(max, Date.parse(r.at) || 0), 0) || null;
      const intervalMs = Number(process.env.PIDECK_RECAP_MS) || RECAP_INTERVAL_MS;
      if (!recapDue(lastMessageAt, lastRecapAt, Date.now(), intervalMs)) return;
      const delta = pickRecapDelta(messages, recaps[recaps.length - 1]?.coveredEntryId ?? null);
      if (!recapWorthy(delta.messages) || !delta.coveredEntryId) return;
      const deltaText = delta.messages.map((m) => messageText(m)).join("\n").slice(0, 8000);
      const text = await this.askCheap(buildRecapPrompt(deltaText), 1024, { cwd: entry.cwd, fallbackModel: session.model });
      const line = normalizeRecapText(text ?? "");
      if (!line) return;
      const recap: Recap = {
        id: randomUUID(),
        at: new Date().toISOString(),
        coveredEntryId: delta.coveredEntryId,
        text: line,
      };
      await this.recaps.append(file, recap);
      this.opts.onEvent({
        type: "babylon_recap",
        sessionId: session.sessionId,
        sessionFile: file,
        recap,
      });
      this.opts.onEvent({ type: "pideck_sessions_changed" });
    } catch {
      // Recaps are best-effort; a failed model call must never surface.
    } finally {
      this.recapping.delete(file);
    }
  }

  // -------------------------------------------------------------------------
  // Snapcompact: driven entirely by the snapcompact Pi extension wired
  // in via `resourceLoaderOptions.extensionsOverride` at session
  // creation time. The extension listens for `session_before_compact`
  // (builds the archive from preparation.messagesToSummarize +
  // preparation.turnPrefixMessages) and `context` (projects the
  // archive transiently into the next LLM call). This host only
  // owns the ArchiveStore and the callbacks the extension reads.
  // -------------------------------------------------------------------------

  private async relayPromotedSubagentReply(session: AgentSession, text: string): Promise<void> {
    if (!text.trim()) return;
    const identity = [...session.sessionManager.getEntries()].reverse().find(
      (entry): entry is CustomMessageEntry =>
        entry.type === "custom_message" && entry.customType === "babylon_subagent_identity"
    );
    const details = wireOf(identity?.details);
    const parentSessionFile = wireStr(details, "parentSessionFile");
    if (typeof parentSessionFile !== "string" || !parentSessionFile || parentSessionFile === session.sessionFile) return;
    try {
      const parent = SessionManager.open(parentSessionFile, undefined, session.sessionManager.getCwd());
      const label = wireStr(details, "name") ?? wireStr(details, "runId")?.slice(0, 8) ?? "subagent";
      parent.appendCustomMessageEntry(
        "babylon_subagent_activity",
        `[Babylon Subagent Activity]\nSubagent ${label} replied:\n\n${text}`,
        true,
        { runId: wireStr(details, "runId"), action: "reply", message: text }
      );
    } catch {
      // Parent may have moved or been deleted; the promoted child remains usable.
    }
  }

  private rejectAllUi(error: Error): void {
    for (const [id, pending] of this.uiRequests) {
      this.uiRequests.delete(id);
      this.opts.onEvent({ type: "extension_ui_cancel", id });
      pending.reject(error);
    }
  }

  /** Respond to an extension dialog request (from the renderer). */
  respondUi(id: string, resp: unknown): void {
    const p = this.uiRequests.get(id);
    if (p) {
      this.uiRequests.delete(id);
      // Answered: the gate is open, so the run it gated resumes. Emit the
      // resolution so the canonical execution feed drops the "approval"
      // entry (otherwise the Agents dock keeps saying "needs input" after the
      // user has already answered).
      this.opts.onEvent({
        type: "extension_ui_response",
        id,
        sessionId: p.sessionId,
        sessionFile: p.sessionFile,
      });
      p.resolve(resp);
    }
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  private async ensureSession(): Promise<void> {
    if (!this.createRuntimeFactory) throw new Error("pi host not started");
  }

  /** Model runtime owning a cwd (for ambient model calls: titles, recaps).
   *  Falls back to the foreground entry's project when cwd is unknown. */
  private async modelRuntimeForCwd(cwd: string): Promise<ModelRuntime> {
    // Strict project lookup: a failure for Project A must never silently
    // become a model call against Project B (no foreground fallback).
    if (!cwd) throw new Error("project cwd is required for model runtime");
    return this.ensureProjectRuntime(cwd);
  }

  /** Pre-warm a project before its first session: build the rollback shadow
   *  index and start the project's shared model runtime. Both are idempotent
   *  and the first session open would do the same work, so this only moves the
   *  cold cost off the critical path of the first send. */
  warmProject(cwd: string): { warmed: true } {
    this.warmSnapshots(cwd);
    void this.ensureProjectRuntime(cwd).catch(() => undefined);
    return { warmed: true };
  }

  /**
   * Compatibility entry point (C11 deletes it). It is exactly "explicit
   *  execution activation + legacy ready status" — NEVER "materialize an
   *  arbitrary retained runtime" (R2/R5). Historical viewing is the
   *  renderer's disk-only viewSession, not this.
   *  systemPrompt is an immutable creation argument for a runtime this call
   *  materializes; an already-installed owner keeps its own.
   */
  async open(opts: { path?: string; cwd: string; requestId?: number; systemPrompt?: string | null }): Promise<AgentState> {
    if (opts.path && this.opts.sessionsRoot) {
      // Sessions are forked per instance: refuse anything outside this
      // instance's root instead of interleaving turns into another owner's file.
      try {
        await validateSessionPath(this.opts.sessionsRoot, opts.path);
      } catch (error: unknown) {
        if (isSessionNotFound(error)) {
          if (!contained(this.opts.sessionsRoot, resolve(opts.path))) {
            throw new Error("session path is outside this instance's sessions root");
          }
        } else throw error;
      }
    }
    const entry = await this.transferExecution(opts.path ?? null, opts.cwd, {
      systemPrompt: opts.systemPrompt,
      requestId: opts.requestId,
    });
    return this.getStateFor(entry);
  }

  /** Pi's switch callback: an EXECUTION HANDOFF, not foregrounding. The
   *  target becomes this project's owner and the source goes cold. Pi may
   *  call this from INSIDE `runtime.fork()` while the source call is still
   *  on the stack, so the source is never disposed from this callback (it
   *  would destroy the runtime performing the fork) — the handoff is staged
   *  and finalized by the operation that triggered it. */
  private async stageHandoff(
    sessionPath: string,
    options?: SwitchSessionOptions & { cwdOverride?: string },
  ): Promise<AgentState> {
    const seq = this.claimActivation();
    const targetCwd = options?.cwdOverride ?? this._cwd;
    const source = this.entryForProject(targetCwd);
    if (source && source.sessionFile === sessionPath) {
      this.touchEntry(source);
      return this.activate(source, { cwd: source.cwd, seq });
    }
    // Detached first: a busy or failing build never installs anything.
    const candidate = await this.materializeExecutionRuntime(sessionPath, targetCwd);
    if (source && (await this.isExecutionBusy(source))) {
      await this.disposeDetachedEntry(candidate);
      throw new ProjectExecutionBusyError(source.sessionFile, source.sessionId);
    }
    // Transient duplicate (R8): the source stays installed until the
    // operation that requested the switch returns and finalizes. With no
    // current owner there is nothing to hand off from — just install.
    this.installExecutionEntry(candidate);
    this.touchEntry(candidate);
    if (source) this.pendingHandoff = { source, candidate, targetFile: sessionPath, targetCwd };
    await this.activate(candidate, { cwd: candidate.cwd, seq });
    if (this.sourceOperationDepth === 0) await this.finalizeHandoff();
    return this.getStateFor(candidate);
  }

  /** Converge a staged handoff once the source operation returned. Returns
   *  the file owning the project afterwards, or null when the handoff was
   *  abandoned because the source went busy (it keeps the project — its work
   *  is never aborted). */
  private async finalizeHandoff(): Promise<string | null> {
    const staged = this.pendingHandoff;
    if (!staged) return null;
    this.pendingHandoff = null;
    if (await this.isExecutionBusy(staged.source)) {
      this.executionByCwd.set(projectKey(staged.source.cwd), staged.source.sessionFile);
      await this.disposeDetachedEntry(staged.candidate);
      return null;
    }
    await this.releaseOwnerEntry(staged.source);
    this.installExecutionEntry(staged.candidate);
    this.emitExecutionChanged(staged.candidate.cwd);
    return staged.targetFile;
  }

  /** Drop a staged handoff without transferring ownership (cancel/failure):
   *  the transient target is disposed and the source keeps the project. */
  private async abandonHandoff(): Promise<void> {
    const staged = this.pendingHandoff;
    if (!staged) return;
    this.pendingHandoff = null;
    this.executionByCwd.set(projectKey(staged.source.cwd), staged.source.sessionFile);
    await this.disposeDetachedEntry(staged.candidate);
  }

  /**
   * Agent-requested new session: a COLD file, never an installed runtime.
   *  Installing one would immediately violate one-hot retention when the
   *  agent's own session is this project's owner. If Pi needs a live runtime
   *  to mint the file, it is built transiently and disposed before we
   *  return; only the transcript survives.
   */
  private async createSessionIn(cwd: string, _options?: NewSessionOptions): Promise<AgentState> {
    const candidate = await this.materializeExecutionRuntime(null, cwd);
    const state = await this.getStateFor(candidate);
    await this.disposeDetachedEntry(candidate);
    this.opts.onEvent({ type: "pideck_sessions_changed" });
    return state;
  }

  private isMissingCwdError(err: unknown): boolean {
    return err instanceof Error && err.name === "MissingSessionCwdError";
  }

  /**
   * Cheap disk identity of a transcript (one stat, no parse). Null when the
   * file is missing or unreadable — callers treat that as "unknown, sync".
   */
  private async fingerprintSessionFile(file: string): Promise<DiskFingerprint | null> {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return null;
      return { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  private sameFingerprint(a: DiskFingerprint | null | undefined, b: DiskFingerprint | null | undefined): boolean {
    // Both missing: still no file, so nothing could have appeared to pull.
    // (A sync attempt would just throw the missing-file error that the
    // caller already treats as "live session stands".)
    if (!a && !b) return true;
    return !!a && !!b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
  }

  /**
   * Pull disk changes for one session WITHOUT foregrounding it. A disk sync
   * must never emit a global ready: a stale refresh completing after a tab
   * switch would otherwise rebind the UI to the old session (ready means
   * "this is now foreground", which sync is not). Callers hydrate the
   * session they display explicitly from the boolean result. Skips the
   * reparse when the disk fingerprint is unchanged (still returns true:
   * the runtime trivially matches disk).
   */
  async refreshFromDisk(sessionPath: string): Promise<boolean> {
    return this.enqueueTransition(sessionPath, async () => {
      const entry = this.sessions.get(sessionPath);
      if (!entry || entry.runtime.session.isStreaming) return false;
      const fp = await this.fingerprintSessionFile(sessionPath);
      if (this.sameFingerprint(fp, entry.diskFingerprint)) return true;
      try {
        this.syncSessionFromDisk(entry, entry.cwd);
      } catch (err) {
        // Unflushed new session: nothing on disk to pull; live state stands.
        if (!isMissingFileError(err)) throw err;
      }
      // Store the fingerprint observed BEFORE the read, not after: an
      // append racing the read must NOT be recorded as ingested. The next
      // comparison then mismatches and forces another sync. A stale-read
      // corner (append landed before open() and was actually included)
      // costs one redundant reparse — toward extra work, never stale state.
      entry.diskFingerprint = fp;
      await this.restoreRollbackLeafFor(entry.runtime.session);
      return true;
    });
  }

  /**
   * Pull append-only changes made by another pi process into an idle
   * session without replacing the extension runtime. A full switch would fire
   * session_shutdown and incorrectly stop persistent threads on every TUI write.
   */
  private syncSessionFromDisk(entry: SessionEntry, cwdOverride: string): void {
    const sessionManager = SessionManager.open(entry.sessionFile, undefined, cwdOverride);
    const context = sessionManager.buildSessionContext();
    const session = entry.runtime.session;
    // Deliberate swap: the disk state is newer (another pi process wrote
    // it), so the live session adopts the fresh manager. The field is
    // readonly in the SDK type, hence the targeted assertion.
    (session as { sessionManager: SessionManager }).sessionManager = sessionManager;
    session.agent.state.messages = context.messages;
    if (context.model) {
      const model = entry.services.modelRuntime.getModel(context.model.provider, context.model.modelId);
      if (model) session.agent.state.model = model;
    }
    // The file stores a plain string; only assign it when it names a level
    // the agent type accepts (a corrupt value must not clobber the live one).
    const level = context.thinkingLevel;
    if (
      level === "off" || level === "minimal" || level === "low" || level === "medium" ||
      level === "high" || level === "xhigh" || level === "max"
    ) {
      session.agent.state.thinkingLevel = level;
    }
  }

  /** Compatibility switch API (C11 deletes it). Semantics match Pi's switch
   *  callback: the target becomes the project owner, the source goes cold,
   *  and no public call returns with two installed entries for one project. */
  async switchTo(sessionPath: string, options?: { cwdOverride?: string }): Promise<AgentState> {
    const state = await this.stageHandoff(sessionPath, options);
    return state;
  }

  // -------------------------------------------------------------------------
  // Agent commands
  // -------------------------------------------------------------------------

  /** Refuse new turns while draining for restart. Idempotent. */
  beginDrain(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** Sessions with live work a restart must not kill: streaming turns,
   *  turns awaiting approval, and sessions with active subagents. */
  activeTurnCount(): number {
    let count = 0;
    for (const [sessionFile, entry] of this.sessions) {
      const session = entry?.runtime?.session;
      if (!session) continue;
      if (session.isStreaming) {
        count++;
      } else if ([...this.uiRequests.values()].some((p) => p.sessionFile === sessionFile)) {
        count++;
      } else if (this.managedSubagents?.hasActiveForSession(session.sessionId)) {
        count++;
      }
    }
    return count;
  }

  /** Wait for live turns to finish, up to timeoutMs. True when quiet. */
  async drainTurns(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (this.activeTurnCount() === 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async prompt(message: string, images: PromptImage[] | undefined, streamingBehavior: "steer" | "followUp" | undefined, sessionFile: string): Promise<void> {
    if (this.draining) throw new Error("daemon is draining for restart; please resend in a moment");
    // Mandatory identity + ownership: a turn may only run in the project's
    // declared execution session. Missing identity is a protocol error;
    // retained historical sessions cannot bypass executionActivate (I4/I7).
    const entry = this.requireExecutionEntry(sessionFile);
    const sessionAtStart = entry.runtime.session;
    const rollbackAtStart = (await this.rollbacks.load(sessionAtStart.sessionId).catch(() => null))?.active;
    const entriesAtStart = entryDigest(sessionAtStart.sessionManager.getEntries());
    // Mid-stream steer/follow-up messages cannot establish a race-free
    // filesystem boundary. They remain part of the active checkpointed turn.
    const checkpoint = streamingBehavior ? null : await this.captureTurnStart(entry);
    const opts: PromptOptions = {};
    // Snapcompact no longer decorates the user message here. The
    // transient archive projection is injected by the snapcompact
    // extension's `context` handler, which runs before every LLM
    // call. This method only forwards the user-supplied message and
    // images so canonical session records remain untouched.
    try {
      if (images?.length) {
        // A configured image model reads attached images when the session's
        // own model has no vision: its description is relayed to the session
        // instead of the raw image blocks. Otherwise images attach directly.
        const settings = this._getSettings();
        const sessionModel = entry.runtime.session.model;
        const described =
          shouldRelayImagesThrough(settings.imageModel, sessionModel)
            ? await this.describeImages(message, images, entry.cwd).catch(() => null)
            : null;
        if (described) message = described;
        else opts.images = toPiImages(images);
      }
      if (streamingBehavior) opts.streamingBehavior = streamingBehavior;
      return await sessionAtStart.prompt(message, opts);
    } finally {
      if (rollbackAtStart && sessionAtStart.sessionId === rollbackAtStart.sessionId) {
        const continued =
          entryDigest(sessionAtStart.sessionManager.getEntries()) !== entriesAtStart ||
          sessionAtStart.sessionManager.getLeafId() !== rollbackAtStart.rollbackLeafId;
        if (continued) await this.rollbacks.clearActive(rollbackAtStart.sessionId).catch(() => undefined);
      }
      if (checkpoint) {
        if ("skipped" in checkpoint) await this.recordTurnSkipped(checkpoint.skipped, entry).catch(() => undefined);
        else await this.captureTurnEnd(checkpoint, entry).catch(() => undefined);
      }
    }
  }
  // A configured image model reads attached images (screenshots, diagrams)
  // when the session's chat model has no vision. The description is appended
  // to the user message as text so a vision-less chat model still sees the
  // content; the raw image blocks are not forwarded. Returns null when no
  // image model is set or the read fails — the caller then falls back to
  // attaching the images directly.
  private async describeImages(message: string, images: PromptImage[], cwd: string): Promise<string | null> {
    const settings = this._getSettings();
    const imageRef = settings.imageModel;
    if (!imageRef) return null;
    const modelRuntime = await this.modelRuntimeForCwd(cwd);
    const model = modelRuntime.getModel(imageRef.provider, imageRef.modelId);
    if (!model) return null;
    try {
      const response = await modelRuntime.completeSimple(
        model,
        {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe each attached image in precise detail: what it shows, every visible text string, layout, colors, and anything a coding assistant needs to act on the screenshot or diagram. Be thorough and concrete." },
                ...(toPiImages(images) ?? []),
              ],
              timestamp: Date.now(),
            },
          ],
        },
        { reasoning: "low", maxTokens: 2048 }
      );
      const text = (response?.content ?? [])
        .map((block) => (block?.type === "text" ? (block.text ?? "") : ""))
        .join("")
        .trim();
      if (!text) return null;
      return `${message}\n\n[Attached image(s) described by ${imageRef.provider}/${imageRef.modelId}]\n${text}`;
    } catch {
      return null;
    }
  }

  /**
   * Reads a sketch: one crop per region, one closed question each, parsed strictly.
   * Reading a drawing is the job the configured image model already exists for,
   * so it is the model used here, and a crop that cannot be read becomes a
   * question rather than a failed compile.
   */
  async classifyRegions(
    cwd: string,
    crops: { regionId: string; dataUrl: string }[]
  ): Promise<Record<string, RegionReading>> {
    const imageRef = this._getSettings().imageModel;
    if (!imageRef) throw new Error("Set an image model in Settings to have a sketch read.");
    const modelRuntime = await this.modelRuntimeForCwd(cwd);
    const model = modelRuntime.getModel(imageRef.provider, imageRef.modelId);
    if (!model) throw new Error(`${imageRef.provider}/${imageRef.modelId} is not available in this project.`);

    if (!crops.length) console.warn("[canvas] classify called with no crops");
    const { readings, problems } = await readCrops(crops, async ({ prompt, image }) =>
      modelRuntime.completeSimple(
        model,
        {
          messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image", ...image }], timestamp: Date.now() }],
        },
        { reasoning: "low", maxTokens: 512 }
      )
    );
    // Unreadable is a question for the human, not a broken compile. The reason
    // still has to be visible, or a classifier that fails every time looks
    // exactly like a drawing nothing could be made of.
    for (const problem of problems) console.warn(`[canvas] ${problem.regionId}: ${problem.reason}`);
    return readings;
  }

  /** Run a `/goal …` control invocation on the foreground session and return
   *  the fresh durable state. Control-plane, not a turn: extension commands
   *  execute immediately inside `session.prompt` and never append a user
   *  message, so unlike `prompt()` this takes no checkpoint, records no
   *  rollback receipt, and wakes no shared-chat extras. */
  async execGoalCommand(sessionFile: string, args: string): Promise<DurableGoalState | null> {
    if (this.draining) throw new Error("daemon is draining for restart; please resend in a moment");
    const text = args ? `/goal ${args}` : "/goal";
    if (!/^\/goal(\s|$)/.test(text)) throw new Error("goal control must be a /goal invocation");
    // Explicit identity, never the foreground pointer: a cancel issued for
    // session A must execute on A even if the UI moved to B mid-flight.
    const entry = this.requireExecutionEntry(sessionFile);
    await entry.runtime.session.prompt(text, {});
    return loadSessionGoal(entry.cwd, entry.sessionId);
  }

  /**
   * Transactional goal start for an explicitly addressed session: persist
   * the objective, then run the message as the turn itself (before_agent_
   * start injects the goal context into that same turn — no synthetic
   * [Goal Mode Start] follow-up, unlike the `/goal <objective>` command).
   * Same 4000-char ceiling as the command path.
   *
   * Turn failures RETURN normally as `{ goal, started, error }` (never
   * throw) so the renderer need not infer anything: `started: false` means
   * the message never became a turn — the persisted goal is rolled back
   * (previous state restored, fresh starts cleared) and the caller drops
   * its optimistic row with the goal OFF. `started: true` (abort, mid-turn
   * model error) means the turn exists with goal context already injected —
   * the goal stands and the caller keeps row and dot. Only validation,
   * unknown-session, and transport failures throw.
   */
  async beginGoalPrompt(
    sessionFile: string,
    objective: string,
    message: string,
    images?: PromptImage[],
    streamingBehavior?: "steer" | "followUp"
  ): Promise<GoalBeginResult> {
    const text = objective.trim();
    if (!text || text.length > 4000) throw new Error("invalid goal objective");
    const entry = this.requireExecutionEntry(sessionFile);
    // Mutual exclusion (backend invariant, not just renderer gating): an
    // active design owns this session's execution model (approval gates).
    // Goal auto-continuation must never run under it — not from the GUI,
    // not from stale state, not from a manual /goal command.
    const blockingDesign = await loadDesignState(entry.cwd, entry.runtime.session.sessionId).catch(() => null);
    if (blockingDesign && !blockingDesign.done) {
      throw new Error("a design session is active — end it before starting a goal");
    }
    const sid = entry.runtime.session.sessionId;
    const previous = await loadSessionGoal(entry.cwd, sid).catch(() => null);
    const digestAtStart = entryDigest(entry.runtime.session.sessionManager.getEntries());
    const config = await loadGoalModeConfig(entry.cwd, defaultDurableGoalModeConfig(), this.trustByCwd.get(entry.cwd) ?? false);
    await saveSessionGoal(entry.cwd, sid, createDurableGoalState(text, config));
    try {
      await this.prompt(message, images, streamingBehavior, sessionFile);
    } catch (e) {
      let started = true;
      try {
        started = entryDigest(entry.runtime.session.sessionManager.getEntries()) !== digestAtStart;
      } catch {
        started = true;
      }
      let goal: DurableGoalState | null = null;
      if (!started) {
        try {
          if (previous) {
            await saveSessionGoal(entry.cwd, sid, previous);
            goal = previous;
          } else {
            await clearSessionGoal(entry.cwd, sid);
          }
        } catch {
          /* restoration is best-effort; the outcome below still reports */
        }
      } else {
        goal = await loadSessionGoal(entry.cwd, entry.runtime.session.sessionId).catch(() => null);
      }
      return { goal, started, error: errorMessage(e, "goal turn failed") };
    }
    return { goal: await loadSessionGoal(entry.cwd, entry.runtime.session.sessionId).catch(() => null), started: true, error: null };
  }
  /**
   * Run a `/design …` control invocation on an explicitly addressed session
   * (same contract as `execGoalCommand`): the extension command runs,
   * follow-ups dispatch, and the fresh design state is read back. Bare
   * `/design` only reports. Path-addressed like every other GUI control —
   * the foreground may move before the backend handles the click.
   */
  async execDesignCommand(sessionFile: string, args: string): Promise<DesignStatus> {
    if (this.draining) throw new Error("daemon is draining for restart; please resend in a moment");
    const text = args ? `/design ${args}` : "/design";
    if (!/^\/design(\s|$)/.test(text)) throw new Error("design control must be a /design invocation");
    const entry = this.requireExecutionEntry(sessionFile);
    await entry.runtime.session.prompt(text, {});
    const design = await loadDesignState(entry.cwd, entry.sessionId);
    return { design, stage: stageOfState(entry.cwd, design) };
  }

  /**
   * Transactional design start for an explicitly addressed session: persist
   * the subject, then run the message as the first interview turn itself
   * (before_agent_start injects the elicit playbook into that same turn —
   * no snapshot-at-click, no "Untitled design" state, no synthetic turn).
   * Overwrites any previous state (including done); on pre-start failure
   * the previous state is restored, on started-turn failure the design
   * stands. Same digest-compensation contract as beginGoalPrompt.
   */
  async beginDesignPrompt(
    sessionFile: string,
    subject: string,
    message: string,
    images?: PromptImage[],
    streamingBehavior?: "steer" | "followUp"
  ): Promise<DesignBeginResult> {
    const text = subject.trim().slice(0, 4000);
    if (!text) throw new Error("invalid design subject");
    const entry = this.requireExecutionEntry(sessionFile);
    // Mutual exclusion, mirrored: an active goal (paused or not) owns this
    // session's execution model. Designing under it would interleave
    // approval gates with autonomous continuation turns.
    const blockingGoal = await loadSessionGoal(entry.cwd, entry.runtime.session.sessionId).catch(() => null);
    if (blockingGoal?.active) {
      throw new Error("a goal is active — stop it before starting a design");
    }
    const sid = entry.runtime.session.sessionId;
    const previous = await loadDesignState(entry.cwd, sid).catch(() => null);
    const digestAtStart = entryDigest(entry.runtime.session.sessionManager.getEntries());
    await saveDesignState(entry.cwd, sid, createDesignState(text, slugFor(text)));
    try {
      await this.prompt(message, images, streamingBehavior, sessionFile);
    } catch (e) {
      let started = true;
      try {
        started = entryDigest(entry.runtime.session.sessionManager.getEntries()) !== digestAtStart;
      } catch {
        started = true;
      }
      let design: DesignState | null = null;
      if (!started) {
        try {
          if (previous) {
            await saveDesignState(entry.cwd, sid, previous);
            design = previous;
          } else {
            await clearDesignState(entry.cwd, sid);
          }
        } catch {
          /* restoration is best-effort; the outcome below still reports */
        }
      } else {
        design = await loadDesignState(entry.cwd, entry.runtime.session.sessionId).catch(() => null);
      }
      return { design, stage: stageOfState(entry.cwd, design), started, error: errorMessage(e, "design turn failed") };
    }
    const design = await loadDesignState(entry.cwd, entry.runtime.session.sessionId).catch(() => null);
    return { design, stage: stageOfState(entry.cwd, design), started: true, error: null };
  }
  /** Abort one session's run. Explicit execution identity — never the
   *  foreground pointer (I8); other sessions keep running untouched. */
  async abort(sessionFile: string): Promise<void> {
    const entry = this.requireExecutionEntry(sessionFile);
    return entry.runtime.session.abort();
  }
  async compact(sessionFile: string, customInstructions?: string): Promise<CompactionResult> {
    const entry = this.requireExecutionEntry(sessionFile);
    return this.enqueueTransition(entry.sessionFile, async () => {
      const session = entry.runtime.session;
      // Manual compact also refreshes the snapcompact archive so a user
      // who clicks Compact and selects "snapcompact" strategy sees a
      // current archive on the next prompt. Non-destructive: the
      // canonical session is untouched.
      // Snapcompact is no longer built here. The session_before_compact
      // hook in the snapcompact extension handles archive generation
      // for both manual and threshold-triggered compactions.
      const before = entryDigest(session.sessionManager.getEntries());
      try {
        return await session.compact(customInstructions);
      } finally {
        if (entryDigest(session.sessionManager.getEntries()) !== before) {
          await this.commitActiveRollback(session.sessionId);
        }
      }
    });
  }

  private async moveToExactLeaf(entry: SessionEntry, targetId: string | null): Promise<void> {
    const session = entry.runtime.session;
    const manager = session.sessionManager;
    if (targetId === null) {
      manager.resetLeaf();
      session.agent.state.messages = manager.buildSessionContext().messages;
      return;
    }
    const target = manager.getEntry(targetId);
    if (!target) throw new Error("The saved history position no longer exists");
    // navigateTree treats a user entry as an editor target and moves to its
    // parent. An old leaf can itself be a user entry after an interrupted turn,
    // so restore that exact leaf directly in this edge case.
    if (target.type === "message" && target.message?.role === "user") {
      manager.branch(targetId);
      session.agent.state.messages = manager.buildSessionContext().messages;
      return;
    }
    const result = await session.navigateTree(targetId, { summarize: false });
    if (result.cancelled) throw new Error("History navigation was cancelled by an extension");
    if (manager.getLeafId() !== targetId) throw new Error("Pi did not restore the expected history position");
  }

  private async restoreRollbackLeafFor(session: AgentSession): Promise<void> {
    const ledger = await this.rollbacks.load(session.sessionId).catch(() => null);
    const active = ledger?.active;
    if (!active || session.sessionFile !== active.sessionFile) return;
    const manager = session.sessionManager;
    if (entryDigest(manager.getEntries()) !== active.entryDigest) {
      await this.rollbacks.clearActive(session.sessionId).catch(() => undefined);
      return;
    }
    if (active.rollbackLeafId === null) manager.resetLeaf();
    else manager.branch(active.rollbackLeafId);
    session.agent.state.messages = manager.buildSessionContext().messages;
  }

  private async captureTurnStart(entry: SessionEntry): Promise<{
    sessionId: string;
    sessionFile: string;
    beforeLeafId: string | null;
    beforeEntryIds: Set<string>;
    before: SnapshotCapture;
  } | { skipped: string } | null> {
    const session = entry.runtime.session;
    const sessionFile = session.sessionFile ?? session.sessionManager.getSessionFile();
    if (!sessionFile) return { skipped: "the session had no file yet" };
    if (session.isStreaming) return { skipped: "a response was already streaming" };
    // The pre-turn checkpoint is the rollback boundary: it MUST reflect the
    // worktree at this instant, so it is an authoritative capture that reads
    // Git/FS directly and never trusts the eventually-consistent watcher.
    const before = await this.snapshots.capture(entry.cwd, { authoritative: true }).catch(() => null);
    if (!before) return { skipped: "the pre-turn snapshot failed" };
    const entries = session.sessionManager.getEntries();
    return {
      sessionId: session.sessionId,
      sessionFile,
      beforeLeafId: session.sessionManager.getLeafId(),
      beforeEntryIds: new Set(entries.map((entry) => entry.id)),
      before,
    };
  }

  /** A turn that never opened a checkpoint still leaves a receipt, so readers
   *  can tell "by design" from "broken". Attaches to the latest user message,
   *  which is the turn's own message in the common case. */
  private async recordTurnSkipped(reason: string, entry: SessionEntry): Promise<void> {
    const session = entry.runtime.session;
    const sessionFile = session.sessionFile ?? session.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const entries = session.sessionManager.getEntries();
    const users = entries.filter((entry) => entry?.type === "message" && entry.message?.role === "user");
    const user = users[users.length - 1];
    if (!user?.id) return;
    await this.rollbacks.recordTurnOutcome({
      receipt: {
        sessionId: session.sessionId,
        sessionFile,
        userEntryId: user.id,
        outcome: "skipped",
        reason,
        createdAt: new Date().toISOString(),
      },
    });
  }

  private async recordTurnFailed(
    start: { sessionId: string; sessionFile: string },
    userId: string | undefined,
    reason: string
  ): Promise<void> {
    if (!userId) return;
    await this.rollbacks.recordTurnOutcome({
      receipt: {
        sessionId: start.sessionId,
        sessionFile: start.sessionFile,
        userEntryId: userId,
        outcome: "failed",
        reason,
        createdAt: new Date().toISOString(),
      },
    });
  }

  /**
   * Test seams for the turn-checkpoint pair (private in production).
   * Integration tests drive them directly to simulate agent turns.
   * captureTurnStart can also report {skipped} or null (no session yet);
   * the seam surfaces that so tests assert the real contract.
   */
  async testCaptureTurnStart(sessionFile: string): Promise<{
    sessionId: string;
    sessionFile: string;
    beforeLeafId: string | null;
    beforeEntryIds: Set<string>;
    before: SnapshotCapture;
  } | { skipped: string } | null> {
    return this.captureTurnStart(this.requireExecutionEntry(sessionFile));
  }

  async testCaptureTurnEnd(start: {
    sessionId: string;
    sessionFile: string;
    beforeLeafId: string | null;
    beforeEntryIds: Set<string>;
    before: SnapshotCapture;
  }, sessionFile: string): Promise<void> {
    // Explicit identity (like prompt(sessionFile)): the turn belongs to its
    // owning session even if the foreground moved while it ran.
    return this.captureTurnEnd(start, this.requireEntry(sessionFile));
  }

  private async captureTurnEnd(start: {
    sessionId: string;
    sessionFile: string;
    beforeLeafId: string | null;
    beforeEntryIds: Set<string>;
    before: SnapshotCapture;
  }, entry: SessionEntry): Promise<void> {
    try {
      await this.captureTurnEndInner(start, entry);
    } catch (error) {
      console.warn("[pideck] turn checkpoint failed:", error instanceof Error ? error.message : error);
    }
  }

  private async captureTurnEndInner(start: {
    sessionId: string;
    sessionFile: string;
    beforeLeafId: string | null;
    beforeEntryIds: Set<string>;
    before: SnapshotCapture;
  }, entry: SessionEntry): Promise<void> {
    const session = entry.runtime.session;
    const sessionFile = session.sessionFile ?? session.sessionManager.getSessionFile();
    const entries = session.sessionManager.getEntries();
    const user = entries.find(
      (entry) => !start.beforeEntryIds.has(entry.id) && entry.type === "message" && entry.message?.role === "user"
    );
    if (session.sessionId !== start.sessionId || sessionFile !== start.sessionFile) {
      await this.recordTurnFailed(start, user?.id, "the session moved to another conversation mid-turn");
      return;
    }
    const finalLeafId = session.sessionManager.getLeafId();
    if (!user || !finalLeafId) {
      await this.recordTurnFailed(start, user?.id, "the turn recorded no new user message or position");
      return;
    }
    // The post-turn snapshot must also be authoritative. `prepareRollback`
    // restores files only for the paths in `changedPaths`, which is derived
    // from this snapshot; a watcher-backed capture that missed the agent's
    // edit would yield an incomplete diff and leave the change in place after
    // a rollback. Reading Git/FS directly guarantees a complete diff.
    // Entry-scoped like the pre-turn capture: the turn belongs to this
    // session's project even if the foreground moved while it ran.
    const after = await this.snapshots.capture(entry.cwd, { authoritative: true }).catch(() => null);
    if (!after || after.root !== start.before.root) {
      await this.recordTurnFailed(
        start,
        user.id,
        !after ? "the post-turn snapshot failed" : "the project root moved mid-turn"
      );
      return;
    }
    // Bookkeeping (the engine's own `.pi/state` logs) mutates as a side
    // effect of running tools, so without this filter every tool-using turn
    // — even a purely read-only one — would report "files changed".
    const changedPaths = (await this.snapshots.changedFiles(entry.cwd, start.before.tree, after.tree)).filter(
      (path) => !isBookkeepingPath(path)
    );
    const exclusions = changedExclusions(start.before.excluded, after.excluded);
    if (changedPaths.length > 5000) exclusions.push("More than 5,000 files changed in one turn");
    const checkpoint: TurnCheckpoint = {
      sessionId: start.sessionId,
      sessionFile: start.sessionFile,
      userEntryId: user.id,
      parentLeafId: user.parentId ?? start.beforeLeafId,
      finalLeafId,
      beforeTree: start.before.tree,
      afterTree: after.tree,
      changedPaths: changedPaths.slice(0, 5000),
      complete: exclusions.length === 0,
      exclusions,
      createdAt: new Date().toISOString(),
    };
    await this.rollbacks.recordTurnOutcome({
      checkpoint,
      receipt: {
        sessionId: start.sessionId,
        sessionFile: start.sessionFile,
        userEntryId: user.id,
        outcome: "checkpointed",
        reason: "checkpoint recorded",
        createdAt: checkpoint.createdAt,
      },
    });
    // Real checkpoint lifecycle → Babylon event stream (renderer maps this to
    // checkpoint.created). Ids only; never checkpoint contents.
    this.opts.onEvent({
      type: "pideck_checkpoint_created",
      sessionId: start.sessionId,
      sessionFile: start.sessionFile,
      userEntryId: user.id,
    });
    this.opts.onEvent({
      type: "pideck_history_changed",
      sessionId: start.sessionId,
      sessionFile: start.sessionFile,
    });
  }

  private async commitActiveRollback(sessionId: string): Promise<void> {
    // Explicit id from the caller — no foreground fallback (I8): every
    // production call site already holds its own session identity.
    await this.rollbacks.clearActive(sessionId).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  async getState(sessionFile: string): Promise<AgentState> {
    // Mandatory identity: no ambient "whatever is foregrounded" read (I8).
    return this.getStateFor(this.requireEntry(sessionFile));
  }

  async getStateFor(entry: SessionEntry): Promise<AgentState> {
    const s = entry.runtime.session;
    const model = toAgentModel(s.model as RuntimeModelLike | null | undefined);
    return {
      model,
      thinkingLevel: s.thinkingLevel,
      isStreaming: s.isStreaming,
      isCompacting: s.isCompacting,
      sessionFile: s.sessionFile ?? null,
      sessionId: s.sessionId,
      sessionName: s.sessionManager.getSessionName?.() ?? undefined,
      autoCompactionEnabled: s.autoCompactionEnabled,
      messageCount: s.messages.length,
      pendingMessageCount: 0,
    };
  }
  async getMessages(sessionFile: string): Promise<unknown[]> {
    // Live-runtime projection for a known session; cold transcripts use the
    // disk transcript/window reads instead.
    const entry = this.requireEntry(sessionFile);
    const messages = entry.runtime.session.messages;
    const userEntries = entry.runtime.session.sessionManager
      .getBranch()
      .filter(
        (entry): entry is SessionMessageEntry => entry.type === "message" && entry.message?.role === "user"
      );
    let userIndex = 0;
    return messages.map((message) => {
      if (message?.role !== "user") return clampToolOutput(message);
      const entry = userEntries[userIndex++];
      return entry ? clampToolOutput({ ...message, entryId: entry.id }) : clampToolOutput(message);
    });
  }
  async getToolOutput(sessionFile: string, toolCallId: string): Promise<{ content: string; truncated: boolean }> {
    // Cold-capable: output lives in the transcript file, no runtime needed
    // (I2). Addressed so expanding B never reads A's identically-named call.
    if (!sessionFile) throw new Error("sessionFile is required");
    return readToolOutput(sessionFile, toolCallId);
  }
  async getStats(sessionFile: string): Promise<SessionStats> {
    const entry = this.requireEntry(sessionFile);
    return toSessionStats(entry.runtime.session.getSessionStats());
  }
  async getCommands(sessionFile: string): Promise<CommandInfo[]> {
    const entry = this.requireEntry(sessionFile);
    const session = entry.runtime.session;
    const services = entry.services;
    const extensionCommands: CommandInfo[] = session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      description: command.description,
      source: "extension",
    }));
    const prompts: CommandInfo[] = services.resourceLoader.getPrompts().prompts.map((prompt: PromptLike) => ({
      name: prompt.name,
      description: prompt.description,
      argumentHint: prompt.argumentHint,
      source: "prompt",
    }));
    const skills = mergeSkillEntries(
      services.resourceLoader.getSkills().skills.map((skill: SkillLike): CommandInfo => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill",
      })),
      // User skills pi's loader misses, filters, or hasn't picked up yet.
      // Same list shape, so `/`, `$`, and palette stay consistent.
      readUserSkillEntries().map((skill) => ({ ...skill, source: "skill" as const }))
    );
    const seen = new Set<string>();
    return [...extensionCommands, ...prompts, ...skills].filter((command) => {
      if (seen.has(command.name)) return false;
      seen.add(command.name);
      return true;
    });
  }
  async getModels(cwd: string): Promise<AgentModel[]> {
    // PROJECT-addressed (not session): ModelRuntime is per-cwd and project
    // extensions affect registration; never the foreground session's services.
    const modelRuntime = await this.ensureProjectRuntime(cwd);
    const available = await modelRuntime.getAvailable();
    const overrides = this._getSettings().contextWindowOverrides ?? {};
    return [...available].map((m) => {
      const key = `${m.provider}/${m.id}`;
      const override = overrides[key];
      const mapped = toAgentModel(m as RuntimeModelLike | null | undefined) ?? { provider: String(m.provider), id: String(m.id) };
      if (typeof override === "number" && override > 0) mapped.contextWindow = override;
      return mapped;
    });
  }
  async setModel(sessionFile: string, provider: string, modelId: string): Promise<{ model: unknown }> {
    const entry = this.requireExecutionEntry(sessionFile);
    return this.enqueueTransition(entry.sessionFile, async () => {
      const model = entry.services.modelRuntime.getModel(provider, modelId);
      if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
      await entry.runtime.session.setModel(model);
      await this.commitActiveRollback(entry.runtime.session.sessionId);
      return { model };
    });
  }
  async setThinking(sessionFile: string, level: string): Promise<unknown> {
    const entry = this.requireExecutionEntry(sessionFile);
    return this.enqueueTransition(entry.sessionFile, async () => {
      // The settings/UI surface only offers valid levels, but the daemon
      // forwards raw strings: validate before handing one to the session.
      const validated = level;
      if (
        validated !== "off" && validated !== "minimal" && validated !== "low" && validated !== "medium" &&
        validated !== "high" && validated !== "xhigh" && validated !== "max"
      ) {
        throw new Error(`Unknown thinking level: ${level}`);
      }
      entry.runtime.session.setThinkingLevel(validated);
      await this.commitActiveRollback(entry.runtime.session.sessionId);
      return {};
    });
  }
  /** Read the user's Babylon preferences (model + reasoning + overrides). */
  async getSettings(): Promise<PiSettings> {
    return this._getSettings();
  }
  /** Merge + persist a patch of the user's Babylon preferences. */
  async setSettings(patch: Partial<PiSettings>): Promise<PiSettings> {
    return this._saveSettings(patch);
  }
  async getThinkingLevels(sessionFile: string): Promise<string[]> {
    const entry = this.requireEntry(sessionFile);
    try {
      // Newer SDKs expose per-model levels; older ones do not.
      const session = entry.runtime.session as AgentSession & { getAvailableThinkingLevels?: () => unknown };
      const levels = session.getAvailableThinkingLevels?.();
      return Array.isArray(levels) && levels.every((l: unknown): l is string => typeof l === "string") ? levels : [];
    } catch {
      return [];
    }
  }
  async setSessionName(sessionFile: string, name: string): Promise<unknown> {
    // Metadata rename needs the retained runtime, not execution ownership
    // (renameSession is the richer path-addressed API; this stays for
    // compatibility until the facade cleanup).
    const entry = this.requireEntry(sessionFile);
    return this.enqueueTransition(entry.sessionFile, async () => {
      entry.runtime.session.setSessionName(name);
      await this.commitActiveRollback(entry.runtime.session.sessionId);
      return {};
    });
  }

  /** Retained entry by file, tolerant of spelling (canonical vs lexical). */
  private findEntry(sessionFile: string): SessionEntry | undefined {
    return (
      this.sessions.get(sessionFile) ??
      [...this.sessions.values()].find((entry) => resolve(entry.sessionFile) === resolve(sessionFile))
    );
  }

  /** "This retained runtime exists." Mutators never auto-open: runtime
   *  creation/ownership transfer belongs to executionActivate alone, so a
   *  cold historical path rejects instead of becoming a hidden activation. */
  private requireEntry(sessionFile: string): SessionEntry {
    if (!sessionFile) throw new Error("sessionFile is required");
    const entry = this.findEntry(sessionFile);
    if (!entry) throw new Error("Session runtime is not available");
    this.touchEntry(entry);
    return entry;
  }

  /** "This retained runtime is the project's execution session" — the guard
   *  every runtime MUTATION uses. Path-addressing alone is not enough:
   *  otherwise a viewed historical session could be explicitly targeted
   *  while another session owns/does project work and still mutate state. */
  private requireExecutionEntry(sessionFile: string): SessionEntry {
    const entry = this.requireEntry(sessionFile);
    const owner = this.executionByCwd.get(entry.cwd);
    if (!owner || resolve(owner) !== resolve(entry.sessionFile)) {
      throw new Error("This session is not the project's execution session");
    }
    return entry;
  }

  /**
   * Rename any session by file — foreground, retained-idle, or never-opened.
   * Retained sessions go through the live runtime (same append + rollback
   * commit as setSessionName, entry-scoped so the live manager stays
   * coherent). Never-opened sessions get a session_info entry appended via
   * a short-lived manager: no runtime is created and the foreground never
   * moves. Throws for unknown (not on disk, not owned) paths.
   */
  async renameSession(sessionFile: string, name: string): Promise<unknown> {
    if (typeof name !== "string" || name.length < 1 || name.length > 500) throw new Error("invalid session name");
    const retained = this.findEntry(sessionFile);
    if (retained) {
      const file = retained.sessionFile;
      return this.enqueueTransition(file, async () => {
        await this.ensureSession();
        const live = this.sessions.get(file) ?? retained;
        live.runtime.session.setSessionName(name);
        await this.commitActiveRollback(live.runtime.session.sessionId);
        return {};
      });
    }
    let target = sessionFile;
    if (this.opts.sessionsRoot) {
      try {
        target = await validateSessionPath(this.opts.sessionsRoot, sessionFile);
      } catch (error: unknown) {
        if (!isSessionNotFound(error)) throw error;
        // Owned but unflushed (canonical future path): resolve lexically,
        // still containment-checked — same fallback as open().
        const lexical = resolve(sessionFile);
        if (!contained(this.opts.sessionsRoot, lexical) || !this.findEntry(lexical)) throw error;
        target = lexical;
      }
    }
    const raced = this.findEntry(target);
    if (raced) {
      const file = raced.sessionFile;
      return this.enqueueTransition(file, async () => {
        await this.ensureSession();
        const live = this.sessions.get(file) ?? raced;
        live.runtime.session.setSessionName(name);
        await this.commitActiveRollback(live.runtime.session.sessionId);
        return {};
      });
    }
    // SessionManager.open tolerates missing files (in-memory manager), so
    // verify existence here: renaming a path with nothing behind it must
    // fail loudly, not resolve vacuously.
    if ((await this.fingerprintSessionFile(target)) === null) {
      throw new SessionNotFoundError(target);
    }
    const manager = SessionManager.open(target, undefined, undefined);
    manager.appendSessionInfo(name);
    return {};
  }

  // -------------------------------------------------------------------------
  // History, rollback, branching and worktrees
  // -------------------------------------------------------------------------

  /**
   * Read context for history/tree/turn projections: prefers the retained
   * runtime, otherwise opens the transcript manager alone — no AgentSession
   * (I2: viewing a cold session never materializes a runtime).
   */
  private async sessionReadContext(sessionFile: string): Promise<{
    entry: SessionEntry | null;
    sessionId: string;
    cwd: string;
    manager: SessionManager;
  }> {
    if (!sessionFile) throw new Error("sessionFile is required");
    const retained = this.findEntry(sessionFile);
    if (retained) {
      const session = retained.runtime.session;
      return { entry: retained, sessionId: session.sessionId, cwd: retained.cwd, manager: session.sessionManager };
    }
    const manager = SessionManager.open(sessionFile, undefined, undefined);
    const header = await readSessionHeader(sessionFile);
    const cwd = wireStr(header ?? undefined, "cwd") ?? resolve(dirname(sessionFile));
    return { entry: null, sessionId: manager.getSessionId(), cwd, manager };
  }

  private entryReadContext(entry: SessionEntry) {
    const session = entry.runtime.session;
    return { entry, sessionId: session.sessionId, cwd: entry.cwd, manager: session.sessionManager };
  }

  private async historyProjection(ctx: {
    entry: SessionEntry | null;
    sessionId: string;
    cwd: string;
    manager: SessionManager;
  }): Promise<HistoryProjection> {
    const { entry, sessionId, cwd, manager } = ctx;
    const rows = flattenSessionTree(manager.getTree());
    const ledger: Ledger = await this.rollbacks.load(sessionId).catch(() => ({ version: 1 as const, checkpoints: [], active: undefined }));
    let active = ledger.active;
    let undoAvailable = false;
    let undoReason: string | undefined;
    const currentSessionFile = entry?.runtime.session.sessionFile ?? manager.getSessionFile();
    const streaming = entry?.runtime.session.isStreaming ?? false;
    if (active) {
      const stale =
        currentSessionFile !== active.sessionFile ||
        manager.getLeafId() !== active.rollbackLeafId ||
        entryDigest(manager.getEntries()) !== active.entryDigest;
      if (stale) {
        await this.rollbacks.clearActive(sessionId).catch(() => undefined);
        active = undefined;
      } else if (streaming) undoReason = "Finish or stop the active response before undoing rollback";
      else undoAvailable = true;
    }
    return projectHistory({
      rows,
      leafId: manager.getLeafId(),
      checkpoints: ledger.checkpoints,
      receipts: ledger.receipts,
      gitAvailable: await this.snapshots.available(cwd),
      streaming,
      activeRollback: active,
      undoAvailable,
      undoReason,
    });
  }

  async getHistory(sessionFile: string): Promise<HistoryProjection> {
    return this.historyProjection(await this.sessionReadContext(sessionFile));
  }

  /** Entry-scoped alias for queued bodies that already hold their target. */
  private getHistoryFor(entry: SessionEntry): Promise<HistoryProjection> {
    return this.historyProjection(this.entryReadContext(entry));
  }

  /** Entry-scoped alias for queued bodies that already hold their target. */
  private moveToExactLeafFor(entry: SessionEntry, targetId: string | null): Promise<void> {
    return this.moveToExactLeaf(entry, targetId);
  }

  async getTurnChanges(sessionFile: string, entryId: string): Promise<TurnChanges> {
    const ctx = await this.sessionReadContext(sessionFile);
    const ledger: Ledger = await this.rollbacks.load(ctx.sessionId).catch(() => ({ version: 1 as const, checkpoints: [], active: undefined }));
    const checkpoint = ledger.checkpoints.find((item) => item.userEntryId === entryId);
    if (!checkpoint) throw new Error(missingCheckpointReason(ledger.receipts, entryId));
    if (!checkpoint.complete) throw new Error("This filesystem checkpoint is incomplete");
    const files = await this.snapshots.turnChanges(ctx.cwd, checkpoint.beforeTree, checkpoint.afterTree);
    const totals = files.reduce(
      (acc, file) => {
        acc.files += 1;
        acc.additions += file.additions;
        acc.deletions += file.deletions;
        return acc;
      },
      { files: 0, additions: 0, deletions: 0 }
    );
    return { userEntryId: entryId, files, totals, exclusions: checkpoint.exclusions };
  }

  async getTurnFileDiff(sessionFile: string, entryId: string, path: string): Promise<TurnFileDiff> {
    const ctx = await this.sessionReadContext(sessionFile);
    const ledger: Ledger = await this.rollbacks.load(ctx.sessionId).catch(() => ({ version: 1 as const, checkpoints: [], active: undefined }));
    const checkpoint = ledger.checkpoints.find((item) => item.userEntryId === entryId);
    if (!checkpoint) throw new Error(missingCheckpointReason(ledger.receipts, entryId));
    if (!checkpoint.complete) throw new Error("This filesystem checkpoint is incomplete");
    return this.snapshots.fileDiff(ctx.cwd, checkpoint.beforeTree, checkpoint.afterTree, path);
  }

  async prepareRollback(sessionFile: string, userEntryId: string): Promise<RollbackPlan> {
    const entry = this.requireExecutionEntry(sessionFile);
    const session = entry.runtime.session;
    if (session.isStreaming) throw new Error("Finish or stop the active response before rolling back");
    if (!session.sessionFile) throw new Error("Send at least one message before rolling back");
    const ledger = await this.rollbacks.load(session.sessionId);
    if (ledger.active) throw new Error("Undo or continue from the active rollback first");
    const branch = session.sessionManager.getBranch();
    const users = branch.filter(
      (entry): entry is SessionMessageEntry => entry.type === "message" && entry.message?.role === "user"
    );
    const targetIndex = users.findIndex((entry) => entry.id === userEntryId);
    if (targetIndex < 0) throw new Error("The selected turn is not on the active path");
    const checkpointByUser = new Map(ledger.checkpoints.map((checkpoint) => [checkpoint.userEntryId, checkpoint]));
    const selected = users.slice(targetIndex);
    // Resolve every selected turn to its checkpoint up front: a missing one
    // throws the user-facing reason here instead of failing halfway through
    // the restore below.
    const checkpoints: TurnCheckpoint[] = selected.map((entry) => {
      const checkpoint = checkpointByUser.get(entry.id);
      if (!checkpoint) throw new Error(missingCheckpointReason(ledger.receipts, entry.id));
      return checkpoint;
    });
    if (checkpoints.some((checkpoint) => !checkpoint.complete)) throw new Error("This filesystem checkpoint is incomplete");
    const target = users[targetIndex];
    if (!target) throw new Error("The selected turn is not on the active path");
    const previousLeafId = session.sessionManager.getLeafId();
    if (!previousLeafId) throw new Error("No active session position");
    // The redo snapshot is what an "undo" later restores from. If it is stale
    // (watcher hadn't fired when the user clicked Rollback), undo will silently
    // revert to the wrong content. Destructive, so authoritative.
    const redo = await this.snapshots.capture(entry.cwd, { authoritative: true });
    if (!redo) throw new Error("Rollback requires a Git project");
    const restoreMap: Record<string, string> = Object.create(null);
    for (const checkpoint of checkpoints as TurnCheckpoint[]) {
      for (const path of checkpoint.changedPaths) {
        // Legacy checkpoints may still list bookkeeping admitted before the
        // capture skip existed; rollback restores project content, never
        // the engine's own logs.
        if (isBookkeepingPath(path)) continue;
        if (!Object.hasOwn(restoreMap, path)) restoreMap[path] = checkpoint.beforeTree;
      }
    }
    const changes = await this.snapshots.preview(entry.cwd, redo.tree, restoreMap);
    const plan = {
      id: randomUUID(),
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      targetUserEntryId: userEntryId,
      expectedLeafId: previousLeafId,
      entryDigest: entryDigest(session.sessionManager.getEntries()),
      redo,
      restoreMap,
      changes,
      abandonedUserEntryIds: selected.map((entry) => entry.id),
      editorText: messageText(target.message),
      createdAt: Date.now(),
    };
    this.rollbackPlans.clear();
    this.rollbackPlans.set(plan.id, plan);
    const counts = {
      added: changes.filter((change) => change.status === "added").length,
      modified: changes.filter((change) => change.status === "modified").length,
      deleted: changes.filter((change) => change.status === "deleted").length,
    };
    return {
      planId: plan.id,
      targetUserEntryId: userEntryId,
      targetText: plan.editorText,
      abandonedCount: plan.abandonedUserEntryIds.length,
      changes,
      counts,
      expiresAt: new Date(plan.createdAt + 10 * 60_000).toISOString(),
    };
  }

  async commitRollback(planId: string): Promise<{ editorText: string; history: HistoryProjection }> {
    // Key on the plan's own session, not the foreground: the plan was
    // prepared against that session and the body below refuses to run
    // against any other.
    const plan = this.rollbackPlans.get(planId);
    // The plan carries its session identity — it IS the addressed
    // capability. No foreground fallback: a plan for a session that lost
    // execution ownership must fail before any file is touched.
    if (!plan || Date.now() - plan.createdAt > 10 * 60_000) throw new Error("The rollback preview expired; review it again");
    const key = plan.sessionFile;
    return this.enqueueTransition(key, async () => {
      const livePlan = this.rollbackPlans.get(planId);
      if (!livePlan || Date.now() - livePlan.createdAt > 10 * 60_000) throw new Error("The rollback preview expired; review it again");
      const entry = this.requireExecutionEntry(livePlan.sessionFile);
      const session = entry.runtime.session;
      const manager = session.sessionManager;
      if (session.isStreaming) throw new Error("Finish or stop the active response before rolling back");
      if (session.sessionId !== livePlan.sessionId || session.sessionFile !== livePlan.sessionFile) throw new Error("The active session changed");
      if (manager.getLeafId() !== livePlan.expectedLeafId || entryDigest(manager.getEntries()) !== livePlan.entryDigest) {
        throw new Error("The session changed; review the rollback again");
      }
      // Drift guard. A stale cache would compare equal to the redo snapshot
      // and let the restore overwrite the user's manual edit. Destructive, so
      // authoritative.
      const current = await this.snapshots.capture(entry.cwd, { authoritative: true });
      if (!current || current.tree !== livePlan.redo.tree) throw new Error("Project files changed; review the rollback again");
      await this.snapshots.restore(entry.cwd, livePlan.restoreMap);
      let navigated = false;
      try {
        const target = manager.getEntry(livePlan.targetUserEntryId);
        let editorText = livePlan.editorText;
        const targetWire = wireOf(target);
        const targetMessage = wireOf(targetWire?.message);
        if (manager.getLeafId() === livePlan.targetUserEntryId && targetWire?.type === "message" && wireStr(targetMessage, "role") === "user") {
          // Pi's navigateTree short-circuits when target === leaf before applying
          // its user-message "move to parent and edit" semantics.
          if (targetWire.parentId === null) manager.resetLeaf();
          else if (typeof targetWire.parentId === "string") manager.branch(targetWire.parentId);
          session.agent.state.messages = manager.buildSessionContext().messages;
        } else {
          const result = await session.navigateTree(livePlan.targetUserEntryId, { summarize: false });
          if (result.cancelled) throw new Error("Rollback was cancelled by an extension");
          editorText = result.editorText ?? editorText;
        }
        navigated = true;
        const rollbackLeafId = target?.parentId ?? null;
        if (manager.getLeafId() !== rollbackLeafId) {
          throw new Error(`Pi did not move to the expected history position (${manager.getLeafId() ?? "root"} != ${rollbackLeafId ?? "root"})`);
        }
        const active: ActiveRollback = {
          version: 1,
          sessionId: livePlan.sessionId,
          sessionFile: livePlan.sessionFile,
          targetUserEntryId: livePlan.targetUserEntryId,
          rollbackLeafId,
          previousLeafId: livePlan.expectedLeafId,
          entryDigest: entryDigest(manager.getEntries()),
          redoTree: livePlan.redo.tree,
          restoreMap: livePlan.restoreMap,
          restoredPaths: Object.keys(livePlan.restoreMap),
          abandonedUserEntryIds: livePlan.abandonedUserEntryIds,
          editorText,
          createdAt: new Date().toISOString(),
          state: "active",
        };
        await this.rollbacks.setActive(livePlan.sessionId, active);
        this.rollbackPlans.delete(planId);
        return { editorText: active.editorText, history: await this.getHistoryFor(entry) };
      } catch (error) {
        if (navigated) {
          await this.moveToExactLeafFor(entry, livePlan.expectedLeafId).catch(() => undefined);
        }
        const redoMap = Object.fromEntries(Object.keys(livePlan.restoreMap).map((path) => [path, livePlan.redo.tree]));
        await this.snapshots.restore(entry.cwd, redoMap).catch(() => undefined);
        throw error;
      }
    });
  }

  async undoRollback(sessionFile: string): Promise<{ history: HistoryProjection }> {
    const entry = this.requireExecutionEntry(sessionFile);
    return this.enqueueTransition(entry.sessionFile, async () => {
      const session = entry.runtime.session;
      const manager = session.sessionManager;
      const ledger = await this.rollbacks.load(session.sessionId);
      const active = ledger.active;
      if (!active) throw new Error("There is no rollback to undo");
      if (session.isStreaming) throw new Error("Finish or stop the active response before undoing rollback");
      if (session.sessionFile !== active.sessionFile || manager.getLeafId() !== active.rollbackLeafId || entryDigest(manager.getEntries()) !== active.entryDigest) {
        await this.rollbacks.clearActive(session.sessionId);
        throw new Error("Undo rollback is no longer available because the session continued");
      }
      // Undo restores the redo tree. The drift check below must see the real
      // current worktree; a stale cache could report no drift and let the
      // restore silently overwrite a manual edit made after the rollback.
      const current = await this.snapshots.capture(entry.cwd, { authoritative: true });
      if (!current) throw new Error("Rollback snapshots are unavailable");
      const drift = await this.snapshots.preview(entry.cwd, current.tree, active.restoreMap);
      if (drift.length) {
        await this.rollbacks.clearActive(session.sessionId);
        throw new Error("Undo rollback is no longer available because restored files changed");
      }
      const redoMap = Object.fromEntries(active.restoredPaths.map((path) => [path, active.redoTree]));
      await this.snapshots.restore(entry.cwd, redoMap);
      let navigated = false;
      try {
        await this.moveToExactLeaf(entry, active.previousLeafId);
        navigated = true;
        await this.rollbacks.clearActive(session.sessionId);
        return { history: await this.getHistoryFor(entry) };
      } catch (error) {
        if (navigated) {
          await this.moveToExactLeaf(entry, active.rollbackLeafId).catch(() => undefined);
        }
        await this.snapshots.restore(entry.cwd, active.restoreMap).catch(() => undefined);
        throw error;
      }
    });
  }

  async getTree(sessionFile: string): Promise<{ rows: SessionTreeRow[]; leafId: string | null }> {
    const { manager } = await this.sessionReadContext(sessionFile);
    return { rows: flattenSessionTree(manager.getTree()), leafId: manager.getLeafId() };
  }
  async getForkMessages(sessionFile: string): Promise<{ entryId: string; text: string }[]> {
    return this.requireEntry(sessionFile).runtime.session.getUserMessagesForForking();
  }
  async fork(sessionFile: string, entryId: string): Promise<{ text?: string; cancelled?: boolean }> {
    const entry = this.requireExecutionEntry(sessionFile);
    return this.enqueueTransition(entry.sessionFile, async () => {
      const sourceSessionId = entry.runtime.session.sessionId;
      // Branching inside the current session must not move ownership; only
      // an actual Pi switch to another session path triggers a handoff.
      this.sourceOperationDepth += 1;
      let r: { selectedText?: string; cancelled?: boolean };
      try {
        r = await entry.runtime.fork(entryId);
      } finally {
        this.sourceOperationDepth -= 1;
      }
      if (r.cancelled) await this.abandonHandoff();
      else await this.finalizeHandoff();
      if (!r.cancelled) await this.rollbacks.clearActive(sourceSessionId).catch(() => undefined);
      return { text: r.selectedText, cancelled: r.cancelled };
    });
  }
  /**
   * Clone (session-level fork). Pi's switch request is the handoff signal:
   * on success the CLONE becomes this project's execution owner and the
   * source goes cold; on cancel the transient clone is disposed and the
   * source keeps the project. Source + clone are never both installed when
   * this returns (R1/R8), and the target file is reported explicitly.
   */
  async clone(sessionFile: string): Promise<{ cancelled?: boolean; sessionFile?: string }> {
    const entry = this.requireExecutionEntry(sessionFile);
    return this.enqueueTransition(entry.sessionFile, async () => {
      const sourceSessionId = entry.runtime.session.sessionId;
      const leafId = entry.runtime.session.sessionManager.getLeafId();
      if (!leafId) throw new Error("no current entry selected");
      this.sourceOperationDepth += 1;
      let r: { cancelled?: boolean };
      try {
        r = await entry.runtime.fork(leafId, { position: "at" });
      } finally {
        this.sourceOperationDepth -= 1;
      }
      if (r.cancelled) {
        await this.abandonHandoff();
        return { cancelled: true };
      }
      const ownerFile = await this.finalizeHandoff();
      if (!ownerFile) return { cancelled: true };
      await this.rollbacks.clearActive(sourceSessionId).catch(() => undefined);
      return { cancelled: false, sessionFile: ownerFile };
    });
  }

  /** Resolve the retained runtime owning a session id (threads, subagents,
   *  and approvals route by this, never by foreground). */
  private entryForSessionId(sessionId: string | null | undefined): SessionEntry | null {
    if (!sessionId) return null;
    for (const entry of this.sessions.values()) {
      if (entry.runtime.session.sessionId === sessionId) return entry;
    }
    return null;
  }

  /** Locate a thread's project by scanning known projects for its state
   *  file (thread records don't carry cwd). Cheap: few projects, cached
   *  readState misses. */
  private async findThreadCwd(threadId: string): Promise<string> {
    const cwds = new Set<string>();
    const active = this.foregroundSessionFile ? this.sessions.get(this.foregroundSessionFile)?.cwd : undefined;
    if (active) cwds.add(active);
    for (const key of this.projectRuntimes.keys()) cwds.add(key);
    cwds.add(this._cwd);
    for (const cwd of cwds) {
      try {
        const state = await this.threads.readState(cwd, threadId);
        if (state) return cwd;
      } catch {
        /* try next */
      }
    }
    throw new Error("Thread not found");
  }

  async controlThread(action: "steer" | "follow-up" | "stop", threadId: string, message?: string): Promise<ThreadState> {
    return this.threads.control(await this.findThreadCwd(threadId), action, threadId, message);
  }

  async promoteThread(threadId: string): Promise<{ sessionFile: string; cwd: string; parentSessionFile: string | null }> {
    return this.threads.promote(await this.findThreadCwd(threadId), threadId);
  }

  private async notifyThreadParent(
    thread: { threadId: string; name: string | null; parentSessionId: string | null },
    action: "steer" | "follow-up" | "stop",
    message?: string
  ): Promise<void> {
    if (!thread.parentSessionId) return;
    const parent = this.entryForSessionId(thread.parentSessionId);
    if (!parent) return;
    const label = thread.name ?? thread.threadId.slice(0, 8);
    const content =
      action === "stop"
        ? `[Babylon Thread Activity]\nThread ${label} was stopped from Activity.`
        : `[Babylon Thread Activity]\nThe user sent this ${action === "steer" ? "steering message" : "follow-up"} to thread ${label}:\n\n${message}`;
    await parent.runtime.session.sendCustomMessage({
      customType: "babylon_thread_activity",
      content,
      // CLI-invisible: pi renders custom messages only when display is true.
      // Babylon reads these by customType (see src/store.ts), old and new.
      display: false,
      details: { threadId: thread.threadId, action, message },
    });
  }

  /** Milestone-watching notifications: the main agent learns when a thread
   *  reaches a checkpoint, blocks, or finishes, without polling. */
  async notifyThreadEvent(thread: { threadId: string; name: string | null; parentSessionId?: string | null }, event: ThreadEvent): Promise<void> {
    if (!thread.parentSessionId) return;
    const parent = this.entryForSessionId(thread.parentSessionId);
    if (!parent) return;
    const label = thread.name ?? thread.threadId.slice(0, 8);
    let content: string;
    // Launch-card status lives beside the content: only terminal events
    // carry one, so it is computed inside the narrowed branch.
    let launchStatus: "failed" | "stopped" | "completed" | undefined;
    if (event.type === "milestone") {
      const name = event.milestone?.name ?? "checkpoint";
      content = `[Babylon Thread Activity]\nThread ${label} reached a milestone, ${name}${event.milestone?.note ? `: ${event.milestone.note}` : ""}`;
      launchStatus = undefined;
    } else if (event.type === "blocked") {
      content = `[Babylon Thread Activity]\nThread ${label} is blocked${event.blocker ? `: ${event.blocker}` : ""}.`;
      launchStatus = undefined;
    } else {
      const done = event.status === "failed" ? "failed" : event.status === "stopped" ? "was stopped" : "completed";
      content = `[Babylon Thread Activity]\nThread ${label} ${done}.`;
      launchStatus = event.status === "failed" ? "failed" : event.status === "stopped" ? "stopped" : event.status === "completed" ? "completed" : undefined;
    }
    await parent.runtime.session.sendCustomMessage({
      customType: "babylon_thread_activity",
      content,
      // CLI-invisible (see above); Babylon reads by customType.
      display: false,
      details: { ...event },
    });
    // Custom messages emit no renderer event on their own; deliver a
    // message_start so the line appears in the visible chat immediately.
    // Stamped with the PARENT identity so background parents accumulate it
    // in the right transcript instead of the foreground one.
    const parentSession = parent.runtime.session;
    this.opts.onEvent({
      type: "message_start",
      message: { role: "custom", customType: "babylon_thread_activity", content, display: false },
      sessionId: parentSession.sessionId,
      sessionFile: parentSession.sessionFile ?? null,
    });
    // Live status + log for the matching LaunchCard in the parent chat:
    // babylon_thread_activity pings update the card instead of a stray line.
    this.opts.onEvent({
      type: "babylon_launch_update",
      runId: thread.threadId,
      runKind: "thread",
      log: content,
      status: launchStatus,
      sessionId: parentSession.sessionId,
      sessionFile: parentSession.sessionFile,
    });
  }

  private async notifySubagentParent(record: ManagedSubagentRecord, action: SubagentParentEvent, message?: string): Promise<void> {
    if (!record.parentSessionId) return;
    const parent = this.entryForSessionId(record.parentSessionId);
    if (!parent) return;
    const label = record.name ?? record.runId.slice(0, 8);
    const content = action === "stop"
      ? `[Babylon Subagent Activity]\nSubagent ${label} was stopped from Activity.`
      : action === "reply"
        ? `[Babylon Subagent Activity]\nSubagent ${label} replied:\n\n${message}`
        : `[Babylon Subagent Activity]\nThe user sent this ${action === "steer" ? "steering message" : "follow-up"} to subagent ${label}:\n\n${message}`;
    await parent.runtime.session.sendCustomMessage({
      customType: "babylon_subagent_activity",
      content,
      // CLI-invisible (see babylon_thread_activity above); Babylon reads by customType.
      display: false,
      details: { runId: record.runId, action, message },
    });
    // Surface custom messages in the visible chat (they emit no renderer event).
    // Stamped with the parent identity for correct background accumulation.
    const parentSession = parent.runtime.session;
    this.opts.onEvent({
      type: "message_start",
      message: { role: "custom", customType: "babylon_subagent_activity", content, display: false },
      sessionId: parentSession.sessionId,
      sessionFile: parentSession.sessionFile ?? null,
    });
    // Live status + log for the matching LaunchCard in the parent chat.
    this.opts.onEvent({
      type: "babylon_launch_update",
      runId: record.runId,
      runKind: "subagent",
      log: content,
      status: action === "stop" ? "stopped" : undefined,
      sessionId: parentSession.sessionId,
      sessionFile: parentSession.sessionFile,
    });
  }

  /** Room turn presence for the renderer ("@x is thinking…"). Carries the
   *  live session identity so stale-session filtering keeps working. */
  emitRoomEvent(sessionFile: string, ev: Record<string, unknown> & { type: string }): void {
    // Stamped with the EMITTING session, never the foreground one (I8).
    const entry = this.findEntry(sessionFile);
    this.opts.onEvent({
      ...ev,
      sessionId: entry?.sessionId ?? null,
      sessionFile: entry?.sessionFile ?? sessionFile,
    });
  }

  /**
   * Bot-to-bot relay line in the live session: an attributed, display-only
   * custom message (same channel as subagent/thread activity) plus the live
   * event the renderer needs to show it without a refresh. Never fakes a
   * user or assistant turn, the transcript stays truthful about who spoke.
   */
  async postBotMessage(originSessionFile: string, content: string, details?: Record<string, unknown>): Promise<void> {
    // Attributed relay into the ORIGIN conversation: explicit entry, not
    // execution-gated (display-side line in the parent chat) and never
    // foreground-derived.
    const entry = this.requireEntry(originSessionFile);
    await entry.runtime.session.sendCustomMessage({
      customType: "babylon_bot_message",
      content,
      // CLI-invisible (see babylon_thread_activity above); Babylon reads by customType.
      display: false,
      details: details ?? {},
    });
    // Surface custom messages in the visible chat (they emit no renderer event).
    this.opts.onEvent({
      type: "message_start",
      message: { role: "custom", customType: "babylon_bot_message", content, display: false },
      sessionId: entry.sessionId,
      sessionFile: entry.sessionFile,
    });
  }

  /** Cheap-model summary call for explicit handoff authoring (never the auto sweep). */
  async summarizeHandoff(cwd: string, promptText: string): Promise<string | null> {
    if (!cwd) throw new Error("handoff summarization requires a project cwd");
    return this.askCheap(promptText, 4096, { cwd });
  }

  /** Install a handoff summary as a native compaction boundary in the live chat.
   *  Refuses when the live session moved on or is mid-turn, honesty over convenience. */
  async consumeHandoff(liveFile: string, summary: string, estimatedTokensBefore: number): Promise<void> {
    return this.enqueueTransition(liveFile, async () => {
      // Mutates the live conversation: execution owner only (I4).
      const entry = this.requireExecutionEntry(liveFile);
      if (entry.runtime.session.isStreaming) throw new Error("Wait for the live turn to finish first");
      const leafId = entry.runtime.session.sessionManager.getLeafId();
      entry.runtime.session.sessionManager.appendCompaction(summary, leafId ?? "", estimatedTokensBefore, {
        kind: "babylon-handoff",
      });
    });
  }

  /** Handoff-consumed presence for the renderer card. Same agent-events channel. */
  emitHandoffEvent(sessionFile: string, ev: Record<string, unknown> & { type: string }): void {
    const entry = this.findEntry(sessionFile);
    this.opts.onEvent({
      ...ev,
      sessionId: entry?.sessionId ?? null,
      sessionFile: entry?.sessionFile ?? sessionFile,
    });
  }

  /** Locate a subagent run's project by run id (records don't carry the
   *  lookup, run dirs do). Control actions address runs, never the
   *  foreground project. */
  private async findSubagentCwd(runId: string): Promise<string> {
    const cwds = this.knownProjectCwds();
    for (const cwd of cwds) {
      try {
        await fsp.access(join(cwd, ".pi", "state", "subagents", "runs", runId));
        return cwd;
      } catch {
        /* try next */
      }
    }
    throw new Error("Subagent run not found");
  }

  async controlSubagent(action: SubagentControlAction, runId: string, message?: string): Promise<ManagedSubagentRecord> {
    return this.managedSubagents.control(await this.findSubagentCwd(runId), action, runId, message);
  }  async promoteSubagent(runId: string): Promise<{ sessionFile: string; cwd: string; parentSessionFile: string | null }> {
    return this.managedSubagents.promote(await this.findSubagentCwd(runId), runId);
  }

  private async hasActiveThreadsForSession(sessionId: string): Promise<boolean> {
    // Scan every known project: threads belong to their parent session, not
    // to whatever project happens to be foregrounded.
    const cwds = new Set<string>(this.projectRuntimes.keys());
    cwds.add(this._cwd);
    for (const cwd of cwds) {
      try {
        const dir = join(cwd, ".pi", "state", "threads");
        const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isDirectory?.()) continue;
          const path = join(dir, entry.name, "thread.json");
          try {
            const raw = await fsp.readFile(path, "utf8");
            const state: unknown = JSON.parse(raw);
            if (wireStr(wireOf(state), "parentSessionId") !== sessionId) continue;
            const status = wireStr(wireOf(state), "status");
            if (status && !["completed", "failed", "stopped"].includes(status)) return true;
          } catch {}
        }
      } catch {}
    }
    return false;
  }


  /** Deliver newly-introduced diagnostics to the active Pi session as visible context.
   *  Bounded to 20 items; uses a custom message so the model can repair post-edit
   *  failures without being interrupted or prompted automatically. */
  async notifyDiagnostics(cwd: string, diagnostics: PiDiagnostic[]): Promise<void> {
    if (!diagnostics.length || !cwd) return;
    // Delivered to the PROJECT's execution owner (or nothing): diagnostics
    // for a quiet project must never be injected into whichever session
    // happens to be foregrounded.
    const entry = this.executionForCwd(cwd);
    if (!entry) return;
    const bounded = diagnostics.slice(0, 20);
    const lines = bounded.map((d) => `${d.file}:${d.line}:${d.character} [${d.severity}]${d.source ? ` (${d.source}${d.code ? `/${d.code}` : ""})` : ""} ${d.message}`);
    const content = `[Babylon Diagnostics]\nNew problems detected:\n${lines.join("\n")}`;
    try {
      await entry.runtime.session.sendCustomMessage({
        customType: "babylon_diagnostics",
        content,
        // CLI-invisible (see babylon_thread_activity above); Babylon reads by customType.
        display: false,
        details: { diagnostics: bounded },
      });
      this.opts.onEvent({
        type: "message_start",
        message: { role: "custom", customType: "babylon_diagnostics", content, display: false },
        sessionId: entry.sessionId,
        sessionFile: entry.sessionFile,
      });
    } catch {
      // Best-effort; diagnostics should never break the session.
    }
  }

  async dispose(): Promise<void> {
    this.rejectAllUi(new Error("host disposed"));
    // Stop the recursive fs.watch watchers before anything else; leaving them
    // running leaks file descriptors for every tracked worktree.
    this.snapshots.dispose();
    try {
      this.rollbacks.close();
    } catch {
      /* ignore */
    }
    await this.managedSubagents?.dispose().catch(() => undefined);
    for (const entry of this.sessions.values()) {
      entry.unsubscribe?.();
      entry.unsubscribe = null;
      try {
        await entry.runtime.session.dispose();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
    this.creatingCandidates.clear();
    this.pendingHandoff = null;
    this.transitionQueues.clear();
    this.foregroundSessionFile = null;
  }

  /**
   * Release one idle runtime. Refuses live runtimes (streaming sessions,
   * sessions with pending UI, sessions with active children) — live work is
   * never evicted — and refuses to remove an EXECUTION OWNER: ownership only
   * changes through activateExecution/deactivateExecution, so a random
   * release can never strand the ownership index (R2/R3).
   */
  async releaseSession(sessionFile: string): Promise<boolean> {
    const entry = this.sessions.get(sessionFile);
    if (!entry) return true;
    if (this.executionByCwd.get(projectKey(entry.cwd)) === sessionFile) return false;
    return this.releaseInstalledEntry(entry);
  }

  /** Release the project's CURRENT owner from inside an ownership
   *  transition (or the Pi handoff finalizer). Same liveness gate, but the
   *  ownership check is bypassed because the caller owns the slot. */
  private async releaseOwnerEntry(entry: SessionEntry): Promise<boolean> {
    return this.releaseInstalledEntry(entry);
  }

  private async releaseInstalledEntry(entry: SessionEntry): Promise<boolean> {
    const sessionFile = entry.sessionFile;
    const session = entry.runtime.session;
    if (session.isStreaming) return false;
    if ([...this.uiRequests.values()].some((p) => p.sessionFile === sessionFile)) return false;
    if (this.managedSubagents?.hasActiveForSession(session.sessionId)) return false;
    // TOCTOU guard: the thread scan awaits, and the session may be
    // addressed (or start streaming) while it runs. Snapshot the lifecycle
    // counter now, revalidate after — any concurrent use aborts the release
    // rather than pulling a live runtime from under its user.
    const observedVersion = entry.lifecycleVersion;
    if (await this.hasActiveThreadsForSession(session.sessionId).catch(() => false)) return false;
    // Final synchronous revalidation: no await may follow these checks
    // before disposal begins.
    if (this.sessions.get(sessionFile) !== entry) return false;
    if (entry.lifecycleVersion !== observedVersion) return false;
    if (entry.runtime.session.isStreaming) return false;
    if ([...this.uiRequests.values()].some((p) => p.sessionFile === sessionFile)) return false;
    if (this.managedSubagents?.hasActiveForSession(entry.sessionId)) return false;
    this.disposeEntry(entry);
    return true;
  }
}
