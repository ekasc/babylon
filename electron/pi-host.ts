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
import { join, resolve } from "node:path";
import { projectHistory } from "./session-history";
import { ActiveRollback, RollbackStore, entryDigest, missingCheckpointReason, type Ledger, type TurnCheckpoint } from "./rollback-store";
import { validateSessionPath, contained } from "./session-path";
import { SnapshotStore, isBookkeepingPath, type RestoreChange, type SnapshotCapture } from "./snapshot-store";
import { createGoalModeExtension, isExternalGoalModeExtension } from "./goal-mode/extension";
import { loadSessionGoal } from "./goal-mode/store";
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
  lastUsedAt: number;
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
  /** Retained session runtimes keyed by session FILE (stable identity).
   *  Execution belongs to these entries; foreground selection never owns
   *  their lifetime. Entries leave only via releaseSession/delete/quit. */
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
  private _cwd: string;
  private readonly snapshots: SnapshotStore;
  private readonly rollbacks: RollbackStore;
  private readonly recaps: RecapStore;
  private readonly recapping = new Set<string>();
  private readonly snapcompact: ArchiveStore;
  /** Project cwds whose rollback shadow index has already been warmed. */
  private readonly warmedSnapshotCwds = new Set<string>();
  /**
   * Bot Mode system-prompt overlay (Hermes SOUL.md equivalent). Set by the
   * owner before `open()` so the cwd-bound resource loader picks it up as pi
   * `appendSystemPrompt`. Null = plain session, no overlay. Stable per bot so
   * provider prefix-caching is preserved within a bot's sessions.
   */
  private botSystemPrompt: string | null = null;

  /** Set (or clear) the Bot Mode prompt overlay for subsequently opened sessions. */
  setBotSystemPrompt(prompt: string | null): void {
    this.botSystemPrompt = prompt && prompt.length > 0 ? prompt : null;
  }
  /** Session file → last observed message timestamp (ms). Event-driven, so the
   *  sweep never reads the session file unless a recap might be due. */
  private readonly lastMessageAt = new Map<string, number>();
  private recapTimer: ReturnType<typeof setInterval> | null = null;
  /** The session file in the foreground, if any (renderer convenience). */
  get activeSessionFile(): string | null {
    return this.foregroundSessionFile;
  }

  /** Active entry for foreground-scoped commands (composer, pickers, panels).
   *  Background execution never routes through here. */
  private activeEntry(): SessionEntry {
    const file = this.foregroundSessionFile;
    const entry = file ? this.sessions.get(file) : undefined;
    if (!entry) throw new Error("pi host has no foreground session");
    entry.lastUsedAt = Date.now();
    return entry;
  }

  /** Resolve a session entry by file, defaulting to the foreground entry.
   *  Used by every operation that must target an explicit session. */
  private resolveEntry(sessionFile?: string | null): SessionEntry {
    const file = sessionFile ?? this.foregroundSessionFile;
    const entry = file ? this.sessions.get(file) : undefined;
    if (!entry) throw new Error(file ? `session is not open: ${file}` : "pi host has no foreground session");
    entry.lastUsedAt = Date.now();
    return entry;
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
    getToolDefinition: (name: string) => ToolDefinition | undefined;
    createContext: () => ExtensionContext;
  } {
    if (sessionId) {
      for (const entry of this.sessions.values()) {
        if (entry.runtime.session.sessionId === sessionId) {
          const session = entry.runtime.session;
          return {
            getToolDefinition: (name: string) => session.getToolDefinition(name),
            createContext: () => session.extensionRunner.createContext(),
          };
        }
      }
    }
    const fallback = this.foregroundSessionFile ? this.sessions.get(this.foregroundSessionFile) : undefined;
    const session = fallback?.runtime.session;
    if (!session) throw new Error("no session available for thread tool execution");
    return {
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
  attachSinks(sinks: { onEvent: (event: unknown) => void; onStatus: HostOptions["onStatus"] }): void {
    this.opts.onEvent = sinks.onEvent;
    this.opts.onStatus = sinks.onStatus;
  }

  /**
   * Test seams: read-only views over host internals for unit tests.
   * Production code never calls these; they exist so tests can assert
   * session bookkeeping without reaching through private fields.
   */
  testSessions(): Map<string, SessionEntry> {
    return this.sessions;
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

  get session(): AgentSession {
    return this.activeEntry().runtime.session;
  }
  /** Foreground entry's services (resource loader, model runtime, settings).
   *  Session creation binds its own copy; this accessor is only for
   *  foreground-scoped UI reads (commands, models, skills). */
  get services(): AgentSessionServices {
    return this.activeEntry().services;
  }
  get cwd(): string {
    const file = this.foregroundSessionFile;
    const entry = file ? this.sessions.get(file) : undefined;
    return entry?.cwd ?? entry?.runtime.cwd ?? this._cwd;
  }
  /** True while the FOREGROUND session is streaming a turn. Drivers (group
   *  rounds, bot DMs) refuse to start when busy. Background sessions stream
   *  independently; query their entries, not this flag. */
  get isStreaming(): boolean {
    try {
      const file = this.foregroundSessionFile;
      return !!file && !!this.sessions.get(file)?.runtime.session.isStreaming;
    } catch {
      return false;
    }
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
          const action = mapToolToAction(toolName, args, this.cwd);
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
      const services = await createAgentSessionServices({
        cwd: runtimeCwd,
        agentDir,
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          appendSystemPrompt: [...(this.botSystemPrompt ? [this.botSystemPrompt] : []), CANVAS_PROMPT],
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
                  const s = self.sessionForServices.get(services as object) ?? self.sessions.get(self.foregroundSessionFile ?? "")?.runtime.session;
                  const m = s?.model;
                  if (!m) return null;
                  return { provider: m.provider, id: m.id, input: m.input };
                },
                getSessionId: () => self.sessionForServices.get(services as object)?.sessionId ?? self.sessions.get(self.foregroundSessionFile ?? "")?.runtime.session.sessionId ?? "",
                getSessionFile: () => self.sessionForServices.get(services as object)?.sessionFile ?? self.sessions.get(self.foregroundSessionFile ?? "")?.runtime.session.sessionFile ?? null,
              } as SnapcompactExtensionOptions),
              createGoalModeExtension({
                getCwd: () => runtimeCwd,
                getSessionId: () => {
                  const id = self.sessionForServices.get(services as object)?.sessionId ?? "";
                  return id || null;
                },
                isProjectTrusted: () => projectTrusted ?? false,
                sendFollowUp: (text) => {
                  const session =
                    self.sessionForServices.get(services as object) ??
                    (self.foregroundSessionFile ? self.sessions.get(self.foregroundSessionFile)?.runtime.session : undefined);
                  if (!session) return;
                  // Fire-and-forget by design (upstream pattern): a failed
                  // dispatch must never break the turn that triggered it,
                  // least of all inside the daemon.
                  void session.sendUserMessage(text, { deliverAs: "followUp" }).catch((err: unknown) =>
                    console.warn("[pideck] goal follow-up failed:", err instanceof Error ? err.message : err)
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
   * Get the retained runtime for a session file, creating it (with its own
   * services, bindings, and event subscription) on first sight. Concurrent
   * creations for the same file share one build. Never touches any other
   * session's runtime: opening B must not abort, invalidate, or rebuild A.
   */
  private readonly creatingSessions = new Map<string, Promise<SessionEntry>>();
  private async ensureSessionRuntime(sessionFile: string, cwd: string): Promise<SessionEntry> {
    const existing = this.sessions.get(sessionFile);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    let pending = this.creatingSessions.get(sessionFile);
    if (!pending) {
      pending = this.createSessionRuntime(sessionFile, cwd).finally(() => {
        if (this.creatingSessions.get(sessionFile) === pending) this.creatingSessions.delete(sessionFile);
      });
      this.creatingSessions.set(sessionFile, pending);
    }
    return pending;
  }

  private async createSessionRuntime(sessionFile: string, cwd: string): Promise<SessionEntry> {
    const sessionManager = SessionManager.open(sessionFile, undefined, cwd);
    return this.createSessionRuntimeWithManager(sessionFile, cwd, sessionManager);
  }

  private async createSessionRuntimeWithManager(sessionFile: string, cwd: string, sessionManager: SessionManager): Promise<SessionEntry> {
    const factory = this.createRuntimeFactory;
    if (!factory) throw new Error("pi host not started");
    const runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir: this.opts.agentDir ?? getAgentDir(),
      sessionManager,
    });
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
      lastUsedAt: Date.now(),
    };
    if (services && typeof services === "object") this.sessionForServices.set(services, runtime.session);
    this.sessions.set(sessionFile, entry);
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
    return entry;
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
        // Extension-requested "switch" is foregrounding, not teardown: ensure
        // the target runtime exists and report it; the renderer decides what
        // to display. Other sessions keep running untouched.
        switchSession: async (sessionPath: string, options?: SwitchSessionOptions) => {
          await this.ensureForeground(sessionPath, options);
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
        void this.suggestSessionName(session);
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
  private async suggestSessionName(session: AgentSession): Promise<void> {
    const sessionId = session.sessionId;
    if (this.sessionNaming.has(sessionId)) return;
    this.sessionNaming.add(sessionId);
    try {
      // Under pi >= 0.84.2 the in-memory manager keeps message content out of
      // getEntries(), so the sample is read from the append-only file.
      const file = session.sessionFile ?? session.sessionManager.getSessionFile();
      const { messages } = file ? await readSessionTail(file) : { messages: [] };
      const userTexts = messages
        .filter((m) => wireOf(m)?.role === "user")
        .map((m) => messageText(wireOf(m)?.content))
        .filter((t: string) => t.trim().length > 0);
      const sample = userTexts.slice(-4).join("\n").slice(0, 1500);
      if (!sample.trim()) return;
      const title = await this.generateSessionTitle(sample, session.sessionManager.getCwd?.() ?? null);
      if (!title || session.sessionManager.getSessionName()) return;
      session.sessionManager.appendSessionInfo(title);
      this.opts.onEvent({ type: "pideck_sessions_changed" });
    } catch {
      // Naming is best-effort; the prompt remains the fallback title.
    } finally {
      this.sessionNaming.delete(sessionId);
    }
  }

  private async generateSessionTitle(sample: string, cwd?: string | null): Promise<string | null> {
    const prompt =
      "You are naming a coding-agent conversation. Reply with ONLY a short title (3-6 words, no quotes, no period) that captures the intent of this conversation:\n\n" +
      sample;
    const text = await this.askCheap(prompt, 1024, cwd);
    if (!text) return null;
    return text.replace(/^["'""]+|["'""]+$/g, "").slice(0, 60);
  }

  async generateGitCommitMessage(context: PreparedCommitContext): Promise<GeneratedCommitMessage> {
    const settings = this._getSettings();
    const ref = settings.gitCommitModel ?? DEFAULT_GIT_COMMIT_MODEL;
    const modelRuntimeForCommit = await this.modelRuntimeForCwd((context as { cwd?: string }).cwd ?? null);
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
  private async askCheap(prompt: string, maxTokens: number, cwd?: string | null): Promise<string | null> {
    const settings = this._getSettings();
    const modelRuntime = await this.modelRuntimeForCwd(cwd);
    const titleModel = settings.titleModel
      ? modelRuntime.getModel(settings.titleModel.provider, settings.titleModel.modelId)
      : undefined;
    const model =
      titleModel ??
      modelRuntime.getModel("opencode-go", "muse-spark-1.2-contributor") ??
      this.sessions.get(this.foregroundSessionFile ?? "")?.runtime.session.model;
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
    const session = this.foregroundSessionFile ? this.sessions.get(this.foregroundSessionFile)?.runtime.session : undefined;
    const file = session?.sessionFile;
    if (!file || !session.sessionManager) return;
    if (session.isStreaming) return;
    if (this.managedSubagents?.hasAnyActive()) return;
    if (this.managedSubagents?.hasActiveForSession(session.sessionId)) return;
    if (await this.hasAnyActiveThreads()) return;
    if (await this.hasActiveThreadsForSession(session.sessionId)) return;
    const intervalMs = Number(process.env.PIDECK_RECAP_MS) || RECAP_INTERVAL_MS;
    const cached = this.lastMessageAt.get(file);
    if (!cached || Date.now() - cached < intervalMs) return;
    // Recap timing is not context pressure. Snapcompact is driven by
    // Pi's real compaction boundary (`session_before_compact`) inside
    // the snapcompact extension; the recap sweep never builds or stores
    // a snapcompact archive.
    await this.maybeRecap(session, file);
  }

  private async maybeRecap(session: AgentSession, file: string): Promise<void> {
    if (this.recapping.has(file)) return;
    if (session.isStreaming) return;
    if (this.managedSubagents?.hasAnyActive()) return;
    if (this.managedSubagents?.hasActiveForSession(session.sessionId)) return;
    if (await this.hasAnyActiveThreads()) return;
    if (await this.hasActiveThreadsForSession(session.sessionId)) return;
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
      const text = await this.askCheap(buildRecapPrompt(deltaText), 1024, session.sessionManager.getCwd?.() ?? null);
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
  private async modelRuntimeForCwd(cwd?: string | null): Promise<ModelRuntime> {
    if (cwd) {
      try {
        return await this.ensureProjectRuntime(cwd);
      } catch {
        /* fall through to foreground */
      }
    }
    const file = this.foregroundSessionFile;
    const entry = file ? this.sessions.get(file) : undefined;
    if (entry) return entry.services.modelRuntime ?? (await this.ensureProjectRuntime(entry.cwd));
    throw new Error("pi host has no model runtime available");
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

  /** Open a session file (or create a new one in cwd). Foregrounds the
   *  retained runtime for the file, creating it on first sight. Other
   *  sessions keep running untouched: opening B never aborts, invalidates,
   *  or rebuilds A. */
  async open(opts: { path?: string; cwd: string; requestId?: number }): Promise<AgentState> {
    // Serialize per target file; unrelated sessions open concurrently.
    const key = opts.path ?? `new:${opts.cwd}`;
    return this.enqueueTransition(key, async () => {
    if (opts.path && this.opts.sessionsRoot) {
      // Sessions are forked per instance: refuse anything outside this
      // instance's root instead of interleaving turns into another owner's file.
      // Existing files get the full symlink-safe check; not-yet-flushed new
      // sessions fall back to containment, since the live session is the
      // source of truth until its first flush.
      try {
        await validateSessionPath(this.opts.sessionsRoot, opts.path);
      } catch (error: unknown) {
        if (error instanceof Error && error.message === "session path does not exist") {
          if (!contained(this.opts.sessionsRoot, resolve(opts.path))) {
            throw new Error("session path is outside this instance's sessions root");
          }
        } else throw error;
      }
    }
    if (opts.path) {
      const existing = this.sessions.get(opts.path);
      if (existing) {
        this.foregroundSessionFile = opts.path;
        existing.lastUsedAt = Date.now();
        if (!existing.runtime.session.isStreaming) {
          try {
            this.syncSessionFromDisk(existing, opts.cwd);
          } catch (err) {
            // Unflushed new session (canonical future path, nothing on disk
            // yet): the live session already is the source of truth.
            if (!isMissingFileError(err)) throw err;
          }
        }
      } else {
        try {
          await this.ensureSessionRuntime(opts.path, opts.cwd);
        } catch (err) {
          // The session's stored cwd doesn't exist (project moved/deleted).
          // Ask for a new location and retry with the override, mirroring pi's
          // interactive-mode prompt.
          if (this.isMissingCwdError(err) && this.opts.onMissingCwd) {
            const storedCwd = opts.cwd;
            const replacement = await this.opts.onMissingCwd(opts.path, storedCwd);
            if (replacement) {
              await this.ensureSessionRuntime(opts.path, replacement);
              this.foregroundSessionFile = opts.path;
              this._cwd = replacement;
              await this.restoreActiveRollbackLeaf();
              const state = await this.getState();
              this.opts.onStatus({ status: "ready", cwd: replacement, sessionPath: opts.path, requestId: opts.requestId, state });
              return state;
            }
            throw err;
          }
          throw err;
        }
        this.foregroundSessionFile = opts.path;
      }
    } else {
      // New session in `cwd`: a fresh runtime + file, never a reset of some
      // other session's runtime. Foreground follows the user's new tab.
      const sm = SessionManager.create(opts.cwd, this.opts.sessionsRoot);
      const file = sm.getSessionFile()!;
      await this.createSessionRuntimeWithManager(file, opts.cwd, sm);
      this.foregroundSessionFile = file;
    }
    this._cwd = opts.cwd;
    await this.restoreActiveRollbackLeaf();
    const state = await this.getState();
    this.lastMessageAt.set(state.sessionFile ?? opts.path ?? opts.cwd, Date.now());
    this.opts.onStatus({ status: "ready", cwd: opts.cwd, sessionPath: state.sessionFile ?? opts.path, requestId: opts.requestId, state });
    return state;
    });
  }

  /** Foreground an existing session without disturbing anything else
   *  (extension-requested "switch" and worktree flows). */
  /** Foreground a session without disturbing anything else
   *  (extension-requested "switch" and worktree flows). Creates the runtime
   *  on demand like the old switch path did; other sessions keep running. */
  async ensureForeground(
    sessionPath: string,
    options?: SwitchSessionOptions & { cwdOverride?: string }
  ): Promise<AgentState> {
    let entry = this.sessions.get(sessionPath);
    if (!entry) {
      entry = await this.ensureSessionRuntime(sessionPath, options?.cwdOverride ?? this._cwd);
    }
    this.foregroundSessionFile = sessionPath;
    entry.lastUsedAt = Date.now();
    this._cwd = entry.cwd;
    const state = await this.getStateFor(entry);
    this.opts.onStatus({ status: "ready", cwd: entry.cwd, sessionPath, state });
    return state;
  }

  /** Create a fresh session runtime in cwd without foregrounding it (agent-
   *  requested new sessions must not hijack the user's view). */
  private async createSessionIn(cwd: string, _options?: NewSessionOptions): Promise<AgentState> {
    const sm = SessionManager.create(cwd, this.opts.sessionsRoot);
    const file = sm.getSessionFile()!;
    await this.createSessionRuntimeWithManager(file, cwd, sm);
    const entry = this.sessions.get(file)!;
    const state = await this.getStateFor(entry);
    this.opts.onEvent({ type: "pideck_sessions_changed" });
    return state;
  }

  private isMissingCwdError(err: unknown): boolean {
    return err instanceof Error && err.name === "MissingSessionCwdError";
  }

  async refreshFromDisk(sessionPath: string): Promise<boolean> {
    return this.enqueueTransition(sessionPath, async () => {
      const entry = this.sessions.get(sessionPath);
      if (!entry || entry.runtime.session.isStreaming) return false;
      try {
        this.syncSessionFromDisk(entry, entry.cwd);
      } catch (err) {
        // Unflushed new session: nothing on disk to pull; live state stands.
        if (!isMissingFileError(err)) throw err;
      }
      if (sessionPath === this.foregroundSessionFile) await this.restoreActiveRollbackLeaf();
      const state = await this.getStateFor(entry);
      this.opts.onStatus({ status: "ready", cwd: entry.cwd, sessionPath, state });
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

  async newSession(opts?: { parentSession?: string }): Promise<AgentState> {
    return this.enqueueTransition(`new:${opts?.parentSession ?? "root"}`, async () => {
      const cwd = this.foregroundSessionFile
        ? (this.sessions.get(this.foregroundSessionFile)?.cwd ?? this._cwd)
        : this._cwd;
      const sm = SessionManager.create(cwd, this.opts.sessionsRoot, opts?.parentSession ? { parentSession: opts.parentSession } : undefined);
      const file = sm.getSessionFile()!;
      await this.createSessionRuntimeWithManager(file, cwd, sm);
      this.foregroundSessionFile = file;
      const state = await this.getState();
      this.opts.onStatus({ status: "ready", cwd, sessionPath: state.sessionFile ?? undefined, state });
      return state;
    });
  }

  async switchTo(sessionPath: string, options?: { cwdOverride?: string }): Promise<AgentState> {
    return this.enqueueTransition(sessionPath, async () => {
      const state = await this.ensureForeground(sessionPath, options);
      return state;
    });
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

  async prompt(message: string, images?: PromptImage[], streamingBehavior?: "steer" | "followUp"): Promise<void> {
    if (this.draining) throw new Error("daemon is draining for restart; please resend in a moment");
    const entry = this.activeEntry();
    const sessionAtStart = entry.runtime.session;
    const rollbackAtStart = (await this.rollbacks.load(sessionAtStart.sessionId).catch(() => null))?.active;
    const entriesAtStart = entryDigest(sessionAtStart.sessionManager.getEntries());
    // Mid-stream steer/follow-up messages cannot establish a race-free
    // filesystem boundary. They remain part of the active checkpointed turn.
    const checkpoint = streamingBehavior ? null : await this.captureTurnStart();
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
        if ("skipped" in checkpoint) await this.recordTurnSkipped(checkpoint.skipped).catch(() => undefined);
        else await this.captureTurnEnd(checkpoint).catch(() => undefined);
      }
    }
  }
  // A configured image model reads attached images (screenshots, diagrams)
  // when the session's chat model has no vision. The description is appended
  // to the user message as text so a vision-less chat model still sees the
  // content; the raw image blocks are not forwarded. Returns null when no
  // image model is set or the read fails — the caller then falls back to
  // attaching the images directly.
  private async describeImages(message: string, images: PromptImage[], cwd: string | null): Promise<string | null> {
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
    cwd: string | null,
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
  async execGoalCommand(args: string): Promise<DurableGoalState | null> {
    if (this.draining) throw new Error("daemon is draining for restart; please resend in a moment");
    const text = args ? `/goal ${args}` : "/goal";
    if (!/^\/goal(\s|$)/.test(text)) throw new Error("goal control must be a /goal invocation");
    const entry = this.activeEntry();
    await entry.runtime.session.prompt(text, {});
    return loadSessionGoal(entry.cwd, entry.sessionId);
  }
  async steer(message: string): Promise<void> {
    const entry = this.activeEntry();
    await this.commitActiveRollback(entry.sessionId);
    return entry.runtime.session.steer(message);
  }
  async followUp(message: string): Promise<void> {
    const entry = this.activeEntry();
    await this.commitActiveRollback(entry.sessionId);
    return entry.runtime.session.followUp(message);
  }
  /** Abort one session's run. Other sessions keep running untouched — this is
   *  what the Agents dock calls to stop a background run. */
  async abort(sessionFile?: string | null): Promise<void> {
    const entry = this.resolveEntry(sessionFile);
    return entry.runtime.session.abort();
  }
  async compact(customInstructions?: string): Promise<CompactionResult> {
    const entry = this.activeEntry();
    return this.enqueueTransition(entry.sessionFile, async () => {
      await this.ensureSession();
      const session = this.session;
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
        if (entryDigest(session.sessionManager.getEntries()) !== before) await this.commitActiveRollback();
      }
    });
  }

  private async moveToExactLeaf(targetId: string | null): Promise<void> {
    const session = this.session;
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

  private async restoreActiveRollbackLeaf(): Promise<void> {
    const session = this.session;
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

  private async captureTurnStart(): Promise<{
    sessionId: string;
    sessionFile: string;
    beforeLeafId: string | null;
    beforeEntryIds: Set<string>;
    before: SnapshotCapture;
  } | { skipped: string } | null> {
    const session = this.session;
    const sessionFile = session.sessionFile ?? session.sessionManager.getSessionFile();
    if (!sessionFile) return { skipped: "the session had no file yet" };
    if (session.isStreaming) return { skipped: "a response was already streaming" };
    // The pre-turn checkpoint is the rollback boundary: it MUST reflect the
    // worktree at this instant, so it is an authoritative capture that reads
    // Git/FS directly and never trusts the eventually-consistent watcher.
    const before = await this.snapshots.capture(this.cwd, { authoritative: true }).catch(() => null);
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
  private async recordTurnSkipped(reason: string): Promise<void> {
    const session = this.session;
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
  async testCaptureTurnStart(): Promise<{
    sessionId: string;
    sessionFile: string;
    beforeLeafId: string | null;
    beforeEntryIds: Set<string>;
    before: SnapshotCapture;
  } | { skipped: string } | null> {
    return this.captureTurnStart();
  }

  async testCaptureTurnEnd(start: {
    sessionId: string;
    sessionFile: string;
    beforeLeafId: string | null;
    beforeEntryIds: Set<string>;
    before: SnapshotCapture;
  }): Promise<void> {
    return this.captureTurnEnd(start);
  }

  private async captureTurnEnd(start: {
    sessionId: string;
    sessionFile: string;
    beforeLeafId: string | null;
    beforeEntryIds: Set<string>;
    before: SnapshotCapture;
  }): Promise<void> {
    try {
      await this.captureTurnEndInner(start);
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
  }): Promise<void> {
    const session = this.session;
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
    const after = await this.snapshots.capture(this.cwd, { authoritative: true }).catch(() => null);
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
    const changedPaths = (await this.snapshots.changedFiles(this.cwd, start.before.tree, after.tree)).filter(
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

  private async commitActiveRollback(sessionId?: string | null): Promise<void> {
    if (!sessionId && this.foregroundSessionFile) {
      sessionId = this.sessions.get(this.foregroundSessionFile)?.sessionId ?? null;
    }
    if (!sessionId) return;
    await this.rollbacks.clearActive(sessionId).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  async getState(): Promise<AgentState> {
    return this.getStateFor(this.activeEntry());
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
  async getMessages(): Promise<unknown[]> {
    await this.ensureSession();
    const messages = this.session.messages;
    const userEntries = this.session.sessionManager
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
  async getToolOutput(toolCallId: string): Promise<{ content: string; truncated: boolean }> {
    const file = this.session.sessionFile;
    if (!file) throw new Error("No session file for the active session");
    return readToolOutput(file, toolCallId);
  }
  async getStats(): Promise<SessionStats> {
    await this.ensureSession();
    return toSessionStats(this.session.getSessionStats());
  }
  async getCommands(): Promise<CommandInfo[]> {
    await this.ensureSession();
    const extensionCommands: CommandInfo[] = this.session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      description: command.description,
      source: "extension",
    }));
    const prompts: CommandInfo[] = this.services.resourceLoader.getPrompts().prompts.map((prompt: PromptLike) => ({
      name: prompt.name,
      description: prompt.description,
      argumentHint: prompt.argumentHint,
      source: "prompt",
    }));
    const skills = mergeSkillEntries(
      this.services.resourceLoader.getSkills().skills.map((skill: SkillLike): CommandInfo => ({
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
  async getModels(): Promise<AgentModel[]> {
    await this.ensureSession();
    const available = await this.services.modelRuntime.getAvailable();
    const overrides = this._getSettings().contextWindowOverrides ?? {};
    return [...available].map((m) => {
      const key = `${m.provider}/${m.id}`;
      const override = overrides[key];
      const mapped = toAgentModel(m as RuntimeModelLike | null | undefined) ?? { provider: String(m.provider), id: String(m.id) };
      if (typeof override === "number" && override > 0) mapped.contextWindow = override;
      return mapped;
    });
  }
  async setModel(provider: string, modelId: string): Promise<{ model: unknown }> {
    const entry = this.activeEntry();
    return this.enqueueTransition(entry.sessionFile, async () => {
      await this.ensureSession();
      const model = this.services.modelRuntime.getModel(provider, modelId);
      if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
      await this.session.setModel(model);
      await this.commitActiveRollback();
      return { model };
    });
  }
  async setThinking(level: string): Promise<unknown> {
    const entry = this.activeEntry();
    return this.enqueueTransition(entry.sessionFile, async () => {
      await this.ensureSession();
      // The settings/UI surface only offers valid levels, but the daemon
      // forwards raw strings: validate before handing one to the session.
      const validated = level;
      if (
        validated !== "off" && validated !== "minimal" && validated !== "low" && validated !== "medium" &&
        validated !== "high" && validated !== "xhigh" && validated !== "max"
      ) {
        throw new Error(`Unknown thinking level: ${level}`);
      }
      this.session.setThinkingLevel(validated);
      await this.commitActiveRollback();
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
  async getThinkingLevels(): Promise<string[]> {
    await this.ensureSession();
    try {
      // Newer SDKs expose per-model levels; older ones do not.
      const session = this.session as AgentSession & { getAvailableThinkingLevels?: () => unknown };
      const levels = session.getAvailableThinkingLevels?.();
      return Array.isArray(levels) && levels.every((l: unknown): l is string => typeof l === "string") ? levels : [];
    } catch {
      return [];
    }
  }
  async setSessionName(name: string): Promise<unknown> {
    const key = this.foregroundSessionFile ?? "host";
    return this.enqueueTransition(key, async () => {
      await this.ensureSession();
      this.session.setSessionName(name);
      await this.commitActiveRollback();
      return {};
    });
  }

  // -------------------------------------------------------------------------
  // History, rollback, branching and worktrees
  // -------------------------------------------------------------------------

  async getHistory(): Promise<HistoryProjection> {
    await this.ensureSession();
    const session = this.session;
    const manager = session.sessionManager;
    const rows = flattenSessionTree(manager.getTree());
    const ledger: Ledger = await this.rollbacks.load(session.sessionId).catch(() => ({ version: 1 as const, checkpoints: [], active: undefined }));
    let active = ledger.active;
    let undoAvailable = false;
    let undoReason: string | undefined;
    if (active) {
      const stale =
        session.sessionFile !== active.sessionFile ||
        manager.getLeafId() !== active.rollbackLeafId ||
        entryDigest(manager.getEntries()) !== active.entryDigest;
      if (stale) {
        await this.rollbacks.clearActive(session.sessionId).catch(() => undefined);
        active = undefined;
      } else if (session.isStreaming) undoReason = "Finish or stop the active response before undoing rollback";
      else undoAvailable = true;
    }
    return projectHistory({
      rows,
      leafId: manager.getLeafId(),
      checkpoints: ledger.checkpoints,
      receipts: ledger.receipts,
      gitAvailable: await this.snapshots.available(this.cwd),
      streaming: session.isStreaming,
      activeRollback: active,
      undoAvailable,
      undoReason,
    });
  }

  async getTurnChanges(entryId: string): Promise<TurnChanges> {
    await this.ensureSession();
    const session = this.session;
    const ledger: Ledger = await this.rollbacks.load(session.sessionId).catch(() => ({ version: 1 as const, checkpoints: [], active: undefined }));
    const checkpoint = ledger.checkpoints.find((item) => item.userEntryId === entryId);
    if (!checkpoint) throw new Error(missingCheckpointReason(ledger.receipts, entryId));
    if (!checkpoint.complete) throw new Error("This filesystem checkpoint is incomplete");
    const files = await this.snapshots.turnChanges(this.cwd, checkpoint.beforeTree, checkpoint.afterTree);
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

  async getTurnFileDiff(entryId: string, path: string): Promise<TurnFileDiff> {
    await this.ensureSession();
    const session = this.session;
    const ledger: Ledger = await this.rollbacks.load(session.sessionId).catch(() => ({ version: 1 as const, checkpoints: [], active: undefined }));
    const checkpoint = ledger.checkpoints.find((item) => item.userEntryId === entryId);
    if (!checkpoint) throw new Error(missingCheckpointReason(ledger.receipts, entryId));
    if (!checkpoint.complete) throw new Error("This filesystem checkpoint is incomplete");
    return this.snapshots.fileDiff(this.cwd, checkpoint.beforeTree, checkpoint.afterTree, path);
  }

  async prepareRollback(userEntryId: string): Promise<RollbackPlan> {
    await this.ensureSession();
    const session = this.session;
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
    const redo = await this.snapshots.capture(this.cwd, { authoritative: true });
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
    const changes = await this.snapshots.preview(this.cwd, redo.tree, restoreMap);
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
    const key = this.foregroundSessionFile ?? "host";
    return this.enqueueTransition(key, async () => {
      await this.ensureSession();
      const plan = this.rollbackPlans.get(planId);
      if (!plan || Date.now() - plan.createdAt > 10 * 60_000) throw new Error("The rollback preview expired; review it again");
      const session = this.session;
      const manager = session.sessionManager;
      if (session.isStreaming) throw new Error("Finish or stop the active response before rolling back");
      if (session.sessionId !== plan.sessionId || session.sessionFile !== plan.sessionFile) throw new Error("The active session changed");
      if (manager.getLeafId() !== plan.expectedLeafId || entryDigest(manager.getEntries()) !== plan.entryDigest) {
        throw new Error("The session changed; review the rollback again");
      }
      // Drift guard. A stale cache would compare equal to the redo snapshot
      // and let the restore overwrite the user's manual edit. Destructive, so
      // authoritative.
      const current = await this.snapshots.capture(this.cwd, { authoritative: true });
      if (!current || current.tree !== plan.redo.tree) throw new Error("Project files changed; review the rollback again");
      await this.snapshots.restore(this.cwd, plan.restoreMap);
      let navigated = false;
      try {
        const target = manager.getEntry(plan.targetUserEntryId);
        let editorText = plan.editorText;
        const targetWire = wireOf(target);
        const targetMessage = wireOf(targetWire?.message);
        if (manager.getLeafId() === plan.targetUserEntryId && targetWire?.type === "message" && wireStr(targetMessage, "role") === "user") {
          // Pi's navigateTree short-circuits when target === leaf before applying
          // its user-message "move to parent and edit" semantics.
          if (targetWire.parentId === null) manager.resetLeaf();
          else if (typeof targetWire.parentId === "string") manager.branch(targetWire.parentId);
          session.agent.state.messages = manager.buildSessionContext().messages;
        } else {
          const result = await session.navigateTree(plan.targetUserEntryId, { summarize: false });
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
          sessionId: plan.sessionId,
          sessionFile: plan.sessionFile,
          targetUserEntryId: plan.targetUserEntryId,
          rollbackLeafId,
          previousLeafId: plan.expectedLeafId,
          entryDigest: entryDigest(manager.getEntries()),
          redoTree: plan.redo.tree,
          restoreMap: plan.restoreMap,
          restoredPaths: Object.keys(plan.restoreMap),
          abandonedUserEntryIds: plan.abandonedUserEntryIds,
          editorText,
          createdAt: new Date().toISOString(),
          state: "active",
        };
        await this.rollbacks.setActive(plan.sessionId, active);
        this.rollbackPlans.delete(planId);
        return { editorText: active.editorText, history: await this.getHistory() };
      } catch (error) {
        if (navigated) {
          await this.moveToExactLeaf(plan.expectedLeafId).catch(() => undefined);
        }
        const redoMap = Object.fromEntries(Object.keys(plan.restoreMap).map((path) => [path, plan.redo.tree]));
        await this.snapshots.restore(this.cwd, redoMap).catch(() => undefined);
        throw error;
      }
    });
  }

  async undoRollback(): Promise<{ history: HistoryProjection }> {
    const key = this.foregroundSessionFile ?? "host";
    return this.enqueueTransition(key, async () => {
      await this.ensureSession();
      const session = this.session;
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
      const current = await this.snapshots.capture(this.cwd, { authoritative: true });
      if (!current) throw new Error("Rollback snapshots are unavailable");
      const drift = await this.snapshots.preview(this.cwd, current.tree, active.restoreMap);
      if (drift.length) {
        await this.rollbacks.clearActive(session.sessionId);
        throw new Error("Undo rollback is no longer available because restored files changed");
      }
      const redoMap = Object.fromEntries(active.restoredPaths.map((path) => [path, active.redoTree]));
      await this.snapshots.restore(this.cwd, redoMap);
      let navigated = false;
      try {
        await this.moveToExactLeaf(active.previousLeafId);
        navigated = true;
        await this.rollbacks.clearActive(session.sessionId);
        return { history: await this.getHistory() };
      } catch (error) {
        if (navigated) {
          await this.moveToExactLeaf(active.rollbackLeafId).catch(() => undefined);
        }
        await this.snapshots.restore(this.cwd, active.restoreMap).catch(() => undefined);
        throw error;
      }
    });
  }

  async getTree(): Promise<{ rows: SessionTreeRow[]; leafId: string | null }> {
    await this.ensureSession();
    const sm = this.session.sessionManager;
    return { rows: flattenSessionTree(sm.getTree()), leafId: sm.getLeafId() };
  }
  async getForkMessages(): Promise<{ entryId: string; text: string }[]> {
    await this.ensureSession();
    return this.session.getUserMessagesForForking();
  }
  async fork(entryId: string): Promise<{ text?: string; cancelled?: boolean }> {
    const key = this.foregroundSessionFile ?? "host";
    return this.enqueueTransition(key, async () => {
      await this.ensureSession();
      const sourceSessionId = this.session.sessionId;
      const r = await this.activeEntry().runtime.fork(entryId);
      if (!r.cancelled) await this.rollbacks.clearActive(sourceSessionId).catch(() => undefined);
      return { text: r.selectedText, cancelled: r.cancelled };
    });
  }
  async clone(): Promise<{ cancelled?: boolean }> {
    const key = this.foregroundSessionFile ?? "host";
    return this.enqueueTransition(key, async () => {
      await this.ensureSession();
      const sourceSessionId = this.session.sessionId;
      const leafId = this.session.sessionManager.getLeafId();
      if (!leafId) throw new Error("no current entry selected");
      const r = await this.activeEntry().runtime.fork(leafId, { position: "at" });
      if (!r.cancelled) await this.rollbacks.clearActive(sourceSessionId).catch(() => undefined);
      return { cancelled: r.cancelled };
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
  emitRoomEvent(ev: Record<string, unknown> & { type: string }): void {
    const file = this.foregroundSessionFile;
    const session = file ? this.sessions.get(file)?.runtime.session : undefined;
    this.opts.onEvent({
      ...ev,
      sessionId: session?.sessionId,
      sessionFile: session?.sessionFile ?? null,
    });
  }

  /**
   * Bot-to-bot relay line in the live session: an attributed, display-only
   * custom message (same channel as subagent/thread activity) plus the live
   * event the renderer needs to show it without a refresh. Never fakes a
   * user or assistant turn, the transcript stays truthful about who spoke.
   */
  async postBotMessage(content: string, details?: Record<string, unknown>): Promise<void> {
    await this.ensureSession();
    await this.session.sendCustomMessage({
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
    });
  }

  /** Cheap-model summary call for explicit handoff authoring (never the auto sweep). */
  async summarizeHandoff(promptText: string): Promise<string | null> {
    await this.ensureSession();
    return this.askCheap(promptText, 4096);
  }

  /** Install a handoff summary as a native compaction boundary in the live chat.
   *  Refuses when the live session moved on or is mid-turn, honesty over convenience. */
  async consumeHandoff(liveFile: string, summary: string, estimatedTokensBefore: number): Promise<void> {
    return this.enqueueTransition(liveFile, async () => {
      await this.ensureSession();
      if (this.session.sessionFile !== liveFile) {
        throw new Error("Live chat changed, reconsume into the current chat");
      }
      if (this.session.isStreaming) throw new Error("Wait for the live turn to finish first");
      const leafId = this.session.sessionManager.getLeafId();
      this.session.sessionManager.appendCompaction(summary, leafId ?? "", estimatedTokensBefore, {
        kind: "babylon-handoff",
      });
    });
  }

  /** Handoff-consumed presence for the renderer card. Same agent-events channel. */
  emitHandoffEvent(ev: Record<string, unknown> & { type: string }): void {
    const file = this.foregroundSessionFile;
    const session = file ? this.sessions.get(file)?.runtime.session : undefined;
    this.opts.onEvent({
      ...ev,
      sessionId: session?.sessionId,
      sessionFile: session?.sessionFile ?? null,
    });
  }

  /** Locate a subagent run's project by run id (records don't carry the
   *  lookup, run dirs do). Control actions address runs, never the
   *  foreground project. */
  private async findSubagentCwd(runId: string): Promise<string> {
    const cwds = new Set<string>();
    const active = this.foregroundSessionFile ? this.sessions.get(this.foregroundSessionFile)?.cwd : undefined;
    if (active) cwds.add(active);
    for (const key of this.projectRuntimes.keys()) cwds.add(key);
    cwds.add(this._cwd);
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

  private async hasAnyActiveThreads(): Promise<boolean> {
    try {
      const dir = join(this.cwd, ".pi", "state", "threads");
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory?.()) continue;
        const path = join(dir, entry.name, "thread.json");
        try {
          const raw = await fsp.readFile(path, "utf8");
          const state = JSON.parse(raw);
          const status = state?.status as string | undefined;
          if (status && !["completed", "failed", "stopped"].includes(status)) return true;
        } catch {}
      }
    } catch {}
    return false;
  }

  /** Deliver newly-introduced diagnostics to the active Pi session as visible context.
   *  Bounded to 20 items; uses a custom message so the model can repair post-edit
   *  failures without being interrupted or prompted automatically. */
  async notifyDiagnostics(diagnostics: PiDiagnostic[]): Promise<void> {
    if (!diagnostics.length) return;
    const bounded = diagnostics.slice(0, 20);
    const lines = bounded.map((d) => `${d.file}:${d.line}:${d.character} [${d.severity}]${d.source ? ` (${d.source}${d.code ? `/${d.code}` : ""})` : ""} ${d.message}`);
    const content = `[Babylon Diagnostics]\nNew problems detected:\n${lines.join("\n")}`;
    try {
      await this.session.sendCustomMessage({
        customType: "babylon_diagnostics",
        content,
        // CLI-invisible (see babylon_thread_activity above); Babylon reads by customType.
        display: false,
        details: { diagnostics: bounded },
      });
      this.opts.onEvent({
        type: "message_start",
        message: { role: "custom", customType: "babylon_diagnostics", content, display: false },
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
    this.creatingSessions.clear();
    this.transitionQueues.clear();
    this.foregroundSessionFile = null;
  }

  /**
   * Release one idle session runtime: unsubscribe its events, reject its
   * pending dialogs, dispose the SDK session, drop its permission rules, and
   * forget it. Refuses live runtimes (streaming sessions, sessions with
   * pending UI, sessions with active children) — live work is never evicted.
   * Returns true when the runtime was released.
   */
  async releaseSession(sessionFile: string): Promise<boolean> {
    const entry = this.sessions.get(sessionFile);
    if (!entry) return true;
    const session = entry.runtime.session;
    if (session.isStreaming) return false;
    if ([...this.uiRequests.values()].some((p) => p.sessionFile === sessionFile)) return false;
    if (this.managedSubagents?.hasActiveForSession(session.sessionId)) return false;
    if (await this.hasActiveThreadsForSession(session.sessionId).catch(() => false)) return false;
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    this.rejectSessionUi(entry, new Error("session released"));
    try {
      session.dispose();
    } catch {
      /* ignore */
    }
    try {
      this.opts.permission?.clearSessionRules(session.sessionId);
    } catch {
      /* ignore */
    }
    this.sessions.delete(sessionFile);
    if (this.foregroundSessionFile === sessionFile) this.foregroundSessionFile = null;
    return true;
  }
}
