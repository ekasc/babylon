// In-process pi host (T3-style architecture).
//
// Instead of spawning `pi --mode rpc` per session, this hosts the pi SDK
// directly in the Electron main process: one shared ModelRuntime + one shared
// resource loader + one AgentSessionRuntime. Sessions are reopened in ~1ms
// (vs ~1.3s for an RPC switch_session) because nothing is rebuilt — the loader
// and model runtime are constructed once and reused, exactly how T3 Code hosts
// the OpenCode SDK in its backend process.
//
// The event stream and IPC surface mirror the RPC protocol, so the renderer is
// unchanged: same event types (message_update, tool_execution_*, agent_start,
// extension_ui_request, ...), same command semantics.

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { flattenSessionTree } from "./session-tree";
import { projectHistory } from "./session-history";
import { ActiveRollback, RollbackStore, entryDigest, type TurnCheckpoint } from "./rollback-store";
import { SnapshotStore, type RestoreChange, type SnapshotCapture } from "./snapshot-store";
import { toPiImages } from "./prompt-images";
import { clampToolOutput, readSessionTail, readToolOutput } from "./sessions";
import { RecapStore } from "./recap-store";
import { getSettings, saveSettings, type PiSettings } from "./app-settings";
import { buildRecapPrompt, normalizeRecapText, pickRecapDelta, recapDue, recapWorthy, RECAP_INTERVAL_MS, type Recap } from "./recap";
import { ManagedSubagents, type ManagedSubagentRecord, type SubagentControlAction, type SubagentParentEvent } from "./subagents";
import { mapToolToAction } from "./permission-agent";
import type { AgentAction, EvalResult, Risk } from "./permissions";

/** Babylon-owned hook used to gate agent tool calls before they execute. */
export interface BabylonPermissionController {
  /** Evaluate an action against static policy + the active execution mode. */
  evaluate(action: AgentAction): EvalResult;
  /** Request interactive approval; resolves true to allow, false to deny. */
  requestApproval(action: AgentAction, risk: Risk): Promise<boolean>;
  /** Drop session-only rules (called when the active session is replaced). */
  clearSessionRules(): void;
}
import { ThreadManager } from "./threads";
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
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: any) => typeof block === "string" ? block : block?.text ?? "").join("");
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

export interface HostOptions {
  cwd: string;
  agentDir?: string;
  /** Babylon-owned state outside project worktrees. */
  stateDir?: string;
  /** Called for every agent event (mirrors RPC stdout events). */
  onEvent: (event: any) => void;
  /** Called with status changes. */
  onStatus: (status: { status: string; message?: string; cwd?: string; sessionPath?: string; requestId?: number; state?: any }) => void;
  /**
   * Called when a session's stored cwd no longer exists. Return the replacement
   * cwd (e.g. from a folder picker), or null/undefined to abort the open.
   */
  onMissingCwd?: (sessionFile: string, storedCwd: string) => Promise<string | null | undefined>;
  /** Resolve project-local settings/extensions/skills before entering a cwd. */
  onProjectTrust?: (cwd: string) => Promise<{ trusted: boolean; remember?: boolean }>;
  /** Babylon permission system controller, if enabled. */
  permission?: BabylonPermissionController;
}

export class PiHost {
  private opts: HostOptions;
  private modelRuntime!: ModelRuntime;
  private runtime!: AgentSessionRuntime;
  private transitionQueue: Promise<unknown> = Promise.resolve();
  private unsubscribeEvents: (() => void) | null = null;
  private uiRequests = new Map<string, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  private _cwd: string;
  private readonly snapshots: SnapshotStore;
  private readonly rollbacks: RollbackStore;
  private readonly recaps: RecapStore;
  private readonly recapping = new Set<string>();
  /** Session file → last observed message timestamp (ms). Event-driven, so the
   *  sweep never reads the session file unless a recap might be due. */
  private readonly lastMessageAt = new Map<string, number>();
  private recapTimer: ReturnType<typeof setInterval> | null = null;
  /** The session file the host currently owns (null when none is open). */
  get activeSessionFile(): string | null {
    return this.runtime?.session?.sessionFile ?? null;
  }

  private managedSubagents!: ManagedSubagents;
  private threads!: ThreadManager;
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

  constructor(opts: HostOptions) {
    this.opts = opts;
    this._cwd = opts.cwd;
    const stateDir = opts.stateDir ?? join(opts.agentDir ?? getAgentDir(), "pideck-state");
    this.snapshots = new SnapshotStore(join(stateDir, "snapshots"));
    this.rollbacks = new RollbackStore(join(stateDir, "rollbacks"));
    this.recaps = new RecapStore(join(stateDir, "recaps"));
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
    return this.runtime.session;
  }
  get cwd(): string {
    return this.runtime.cwd ?? this._cwd;
  }

  /** One-time boot: share the model catalogue, but rebuild every cwd-bound service on replacement. */
  async start(): Promise<void> {
    const agentDir = this.opts.agentDir ?? getAgentDir();
    const cwd = resolve(this.opts.cwd);
    this.modelRuntime = await ModelRuntime.create();
    this.managedSubagents = new ManagedSubagents({
      agentDir,
      modelRuntime: this.modelRuntime,
      onUpdate: () => this.opts.onEvent({ type: "pideck_subagents_changed" }),
      onParentMessage: (record, action, message) => this.notifySubagentParent(record, action, message),
    });
    this.threads = new ThreadManager({
      runTool: (toolName, args) => {
        const session = this.runtime.session;
        const tool = session.getToolDefinition(toolName);
        if (!tool) throw new Error("Threads extension is not available in this session");
        return tool.execute(
          `babylon-thread-${randomUUID()}`,
          args,
          undefined,
          undefined,
          session.extensionRunner.createContext()
        );
      },
      onParentMessage: (thread, action, message) => this.notifyThreadParent(thread, action, message),
    });
    const trustStore = new ProjectTrustStore(agentDir);
    const globalSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const trustByCwd = new Map<string, boolean>();

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
      // cwd-bound. Reusing them after session replacement makes project A leak
      // into project B and leaves extension contexts stale. Only ModelRuntime is
      // process-wide and safe to share.
      const settingsManager = SettingsManager.create(runtimeCwd, agentDir, { projectTrusted });
      const services = await createAgentSessionServices({
        cwd: runtimeCwd,
        agentDir,
        settingsManager,
        modelRuntime: this.modelRuntime,
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager: input.sessionManager,
        sessionStartEvent: input.sessionStartEvent,
        customTools: [this.managedSubagents.tool()],
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

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      // Warming the host must not create a visible empty session on disk.
      sessionManager: SessionManager.inMemory(cwd),
    });
    this.runtime.setBeforeSessionInvalidate(() => {
      this.unsubscribeEvents?.();
      this.unsubscribeEvents = null;
      this.rejectAllUi(new Error("session replaced"));
    });
    this.runtime.setRebindSession((session) => this.bindSession(session));
    await this.bindSession(this.runtime.session);
  }

  private async bindSession(session: AgentSession): Promise<void> {
    // Extension UI context: dialogs emit extension_ui_request events and await
    // a response (mirrors RPC's extension_ui_request/response protocol).
    const dialog = (request: any, pick: (r: any) => any, opts?: any) =>
      new Promise((resolveDialog, rejectDialog) => {
        const id = `ui-${crypto.randomUUID()}`;
        let timeout: NodeJS.Timeout | undefined;
        const finish = (response: any) => {
          if (timeout) clearTimeout(timeout);
          resolveDialog(pick(response));
        };
        const reject = (error: Error) => {
          if (timeout) clearTimeout(timeout);
          rejectDialog(error);
        };
        this.uiRequests.set(id, { resolve: finish, reject });
        this.opts.onEvent({ type: "extension_ui_request", id, ...request, timeout: opts?.timeout });
        if (typeof opts?.timeout === "number" && opts.timeout > 0) {
          timeout = setTimeout(() => {
            if (!this.uiRequests.delete(id)) return;
            this.opts.onEvent({ type: "extension_ui_cancel", id });
            finish({ cancelled: true });
          }, opts.timeout);
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

    const uiContext: any = {
      mode: "rpc",
      hasUI: true,
      select: (title: string, options: string[], opts?: any) =>
        dialog({ method: "select", title, options }, (r) =>
          r && r.cancelled ? undefined : r?.value
        , opts),
      confirm: (title: string, message?: string, opts?: any) =>
        dialog({ method: "confirm", title, message }, (r) => !!r?.confirmed, opts),
      input: (title: string, opts?: any) =>
        dialog({ method: "input", title, placeholder: opts?.placeholder }, (r) =>
          r && r.cancelled ? undefined : r?.value
        , opts),
      editor: (title: string, prefill?: string, opts?: any) =>
        dialog({ method: "editor", title, prefill }, (r) =>
          r && r.cancelled ? undefined : r?.value
        , opts),
      notify: (message: string, typeOrOptions?: any) => {
        const notifyType =
          typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions?.notifyType ?? "info";
        this.opts.onEvent({
          type: "extension_ui_request",
          id: `notify-${crypto.randomUUID()}`,
          method: "notify",
          message,
          notifyType,
        });
        return Promise.resolve();
      },
      setStatus: () => Promise.resolve(),
      setWidget: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      set_editor_text: () => Promise.resolve(),
      setWorkingMessage: () => {},
      setWorkingIndicator: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setEditorComponent: () => {},
      setToolsExpanded: () => {},
      getEditorText: () => "",
      getToolsExpanded: () => false,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false as const, error: "not supported" }),
      custom: () => undefined,
    };

    await session.bindExtensions({
      uiContext,
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (options: any) => this.newSession(options),
        fork: async (entryId: string, forkOptions: any) => {
          const sourceSessionId = this.runtime.session.sessionId;
          const r = await this.runtime.fork(entryId, forkOptions);
          if (!r.cancelled) await this.rollbacks.clearActive(sourceSessionId).catch(() => undefined);
          return { cancelled: r.cancelled };
        },
        navigateTree: async (targetId: string, options: any) => {
          const sourceSessionId = session.sessionId;
          const previousLeaf = session.sessionManager.getLeafId();
          const r = await session.navigateTree(targetId, options);
          if (!r.cancelled && session.sessionManager.getLeafId() !== previousLeaf) {
            await this.rollbacks.clearActive(sourceSessionId).catch(() => undefined);
          }
          return { cancelled: r.cancelled };
        },
        switchSession: (sessionPath: string, options: any) =>
          this.switchTo(sessionPath, options),
        reload: async () => {
          await session.reload();
        },
      },
      shutdownHandler: () => {},
      onError: (err: any) => {
        const msg = err?.error ?? String(err);
        // Lifecycle noise: extension async init (e.g. MCP server startup) that
        // was still in flight when the session was replaced hits pi's stale-ctx
        // guard. The extension self-heals via its own generation guard, so this
        // is expected during fast session switches — don't surface it as an
        // error toast.
        if (typeof msg === "string" && msg.includes("extension ctx is stale")) return;
        this.opts.onEvent({ type: "extension_error", extensionPath: err?.extensionPath, event: err?.event, error: msg });
      },
    });
    this.unsubscribeEvents?.();
    // Babylon permission system: intercept every agent tool call before it
    // runs. We wrap the SDK-installed beforeToolCall hook so managed-subagent
    // and other extension tool_call handlers keep working underneath us.
    if (this.opts.permission) {
      const controller = this.opts.permission;
      const agent = session.agent as any;
      const originalBefore = agent.beforeToolCall?.bind(agent);
      controller.clearSessionRules();
      agent.beforeToolCall = async (ctx: any, signal: any) => {
        const action = mapToolToAction(ctx?.toolCall?.name ?? "", ctx?.args, this.cwd);
        if (action) {
          const result = controller.evaluate(action);
          if (result.decision === "deny") {
            return { block: true, reason: result.reason ?? "Blocked by Babylon permission policy" };
          }
          if (result.decision === "ask") {
            const allowed = await controller.requestApproval(action, result.risk ?? "uncertain");
            if (!allowed) return { block: true, reason: "Denied by user approval" };
          }
        }
        return originalBefore ? originalBefore(ctx, signal) : undefined;
      };
    }

    this.unsubscribeEvents = session.subscribe((event) => {
      this.opts.onEvent({ ...event, sessionId: session.sessionId, sessionFile: session.sessionFile });
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
      const { messages } = file ? await readSessionTail(file) : { messages: [] as any[] };
      const userTexts = messages
        .filter((m: any) => m.role === "user")
        .map((m: any) => messageText(m))
        .filter((t: string) => t.trim().length > 0);
      const sample = userTexts.slice(-4).join("\n").slice(0, 1500);
      if (!sample.trim()) return;
      const title = await this.generateSessionTitle(sample);
      if (!title || session.sessionManager.getSessionName()) return;
      session.sessionManager.appendSessionInfo(title);
      this.opts.onEvent({ type: "pideck_sessions_changed" });
    } catch {
      // Naming is best-effort; the prompt remains the fallback title.
    } finally {
      this.sessionNaming.delete(sessionId);
    }
  }

  private async generateSessionTitle(sample: string): Promise<string | null> {
    const prompt =
      "You are naming a coding-agent conversation. Reply with ONLY a short title (3-6 words, no quotes, no period) that captures the intent of this conversation:\n\n" +
      sample;
    const text = await this.askCheap(prompt, 200);
    if (!text) return null;
    return text.replace(/^["'“”]+|["'“”]+$/g, "").slice(0, 60);
  }

  /** One cheap model call shared by naming and recaps. The model + reasoning
   *  level are configurable (Settings → Pi → Title generation), falling back
   *  to the previous hardcoded cheap model when unset. */
  private async askCheap(prompt: string, maxTokens: number): Promise<string | null> {
    const settings = getSettings();
    const titleModel = settings.titleModel
      ? this.modelRuntime.getModel(settings.titleModel.provider, settings.titleModel.modelId)
      : undefined;
    const model =
      titleModel ??
      this.modelRuntime.getModel("opencode-go", "deepseek-v4-flash") ??
      this.runtime.session.model;
    if (!model) return null;
    const reasoning = (settings.titleReasoning as any) || "low";
    try {
      const response = await this.modelRuntime.completeSimple(
        model,
        { messages: [{ role: "user", content: prompt }] } as any,
        { reasoning, maxTokens }
      );
      return (response?.content ?? [])
        .map((block: any) => (block?.type === "text" ? block.text ?? "" : ""))
        .join("")
        .trim();
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
    const session = this.runtime?.session;
    const file = session?.sessionFile;
    if (!file || !session.sessionManager) return;
    const intervalMs = Number(process.env.PIDECK_RECAP_MS) || RECAP_INTERVAL_MS;
    const cached = this.lastMessageAt.get(file);
    if (!cached || Date.now() - cached < intervalMs) return;
    await this.maybeRecap(session, file);
  }

  private async maybeRecap(session: AgentSession, file: string): Promise<void> {
    if (this.recapping.has(file)) return;
    this.recapping.add(file);
    try {
      // The in-memory session manager keeps message content out of getEntries()
      // for large sessions, so the delta is read from the append-only file —
      // the same projection the transcript uses, with entryIds attached.
      const { messages } = await readSessionTail(file);
      if (!messages.length) return;
      const lastMessageAt = messages.reduce(
        (max, m) => Math.max(max, typeof m?.timestamp === "number" ? m.timestamp : 0),
        0
      );
      if (!lastMessageAt) return;
      const recaps = await this.recaps.recapsFor(file);
      const lastRecapAt = recaps.reduce((max, r) => Math.max(max, Date.parse(r.at) || 0), 0) || null;
      const intervalMs = Number(process.env.PIDECK_RECAP_MS) || RECAP_INTERVAL_MS;
      if (!recapDue(lastMessageAt, lastRecapAt, Date.now(), intervalMs)) return;
      const delta = pickRecapDelta(messages, recaps[recaps.length - 1]?.coveredEntryId ?? null);
      if (!recapWorthy(delta.messages) || !delta.coveredEntryId) return;
      const deltaText = delta.messages.map((m) => messageText(m)).join("\n").slice(0, 8000);
      const text = await this.askCheap(buildRecapPrompt(deltaText), 320);
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

  private async relayPromotedSubagentReply(session: AgentSession, text: string): Promise<void> {
    if (!text.trim()) return;
    const identity = [...session.sessionManager.getEntries()].reverse().find(
      (entry: any) => entry.type === "custom_message" && entry.customType === "babylon_subagent_identity"
    ) as any;
    const parentSessionFile = identity?.details?.parentSessionFile;
    if (typeof parentSessionFile !== "string" || !parentSessionFile || parentSessionFile === session.sessionFile) return;
    try {
      const parent = SessionManager.open(parentSessionFile, undefined, session.sessionManager.getCwd());
      const label = identity.details?.name ?? identity.details?.runId?.slice?.(0, 8) ?? "subagent";
      parent.appendCustomMessageEntry(
        "babylon_subagent_activity",
        `[Babylon Subagent Activity]\nSubagent ${label} replied:\n\n${text}`,
        true,
        { runId: identity.details?.runId, action: "reply", message: text }
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

  private enqueueTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionQueue.then(operation, operation);
    this.transitionQueue = result.catch(() => undefined);
    return result;
  }

  /** Respond to an extension dialog request (from the renderer). */
  respondUi(id: string, resp: any): void {
    const p = this.uiRequests.get(id);
    if (p) {
      this.uiRequests.delete(id);
      p.resolve(resp);
    }
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  private async ensureSession(): Promise<void> {
    if (!this.runtime) throw new Error("pi host not started");
  }

  /** Open a session file (or create a new one in cwd). Instant: shared services. */
  async open(opts: { path?: string; cwd: string; requestId?: number }): Promise<any> {
    return this.enqueueTransition(async () => {
    await this.ensureSession();
    if (opts.path) {
      if (this.runtime.session.sessionFile === opts.path) {
        if (!this.runtime.session.isStreaming) this.syncSessionFromDisk(opts.path, opts.cwd);
      } else {
        try {
          // switchSession builds the target SessionManager with a cwd override
          // and reuses our shared services via createRuntime — ~1ms.
          await this.runtime.switchSession(opts.path, { cwdOverride: opts.cwd });
        } catch (err) {
          // The session's stored cwd doesn't exist (project moved/deleted).
          // Ask for a new location and retry with the override — mirroring pi's
          // interactive-mode prompt.
          if (this.isMissingCwdError(err) && this.opts.onMissingCwd) {
            const storedCwd = opts.cwd;
            const replacement = await this.opts.onMissingCwd(opts.path, storedCwd);
            if (replacement) {
              await this.runtime.switchSession(opts.path, { cwdOverride: replacement });
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
      }
    } else {
      // New session in `cwd`. If the runtime is already there, just reset;
      // otherwise rebuild a runtime bound to the new cwd.
      if (this.runtime.cwd === opts.cwd && this.runtime.session.sessionManager.isPersisted()) {
        await this.runtime.newSession({});
      } else {
        // A new SessionManager already has a canonical future path even before
        // its first flush. Opening that path builds a fresh runtime in the new
        // cwd without persisting an empty startup session.
        const sm = SessionManager.create(opts.cwd);
        await this.runtime.switchSession(sm.getSessionFile()!, { cwdOverride: opts.cwd });
      }
    }
    this._cwd = opts.cwd;
    await this.restoreActiveRollbackLeaf();
    const state = await this.getState();
    this.lastMessageAt.set(state.sessionFile ?? opts.path ?? opts.cwd, Date.now());
    this.opts.onStatus({ status: "ready", cwd: opts.cwd, sessionPath: state.sessionFile ?? opts.path, requestId: opts.requestId, state });
    return state;
    });
  }

  private isMissingCwdError(err: unknown): boolean {
    return err instanceof Error && (err as any).name === "MissingSessionCwdError";
  }

  async refreshFromDisk(sessionPath: string): Promise<boolean> {
    return this.enqueueTransition(async () => {
      await this.ensureSession();
      if (this.runtime.session.sessionFile !== sessionPath || this.runtime.session.isStreaming) return false;
      this.syncSessionFromDisk(sessionPath, this.cwd);
      await this.restoreActiveRollbackLeaf();
      const state = await this.getState();
      this.opts.onStatus({ status: "ready", cwd: this.cwd, sessionPath, state });
      return true;
    });
  }

  /**
   * Pull append-only changes made by another pi process into the current idle
   * session without replacing the extension runtime. A full switch would fire
   * session_shutdown and incorrectly stop persistent threads on every TUI write.
   */
  private syncSessionFromDisk(sessionPath: string, cwdOverride: string): void {
    const sessionManager = SessionManager.open(sessionPath, undefined, cwdOverride);
    const context = sessionManager.buildSessionContext();
    const session = this.runtime.session;
    (session as any).sessionManager = sessionManager;
    session.agent.state.messages = context.messages;
    if (context.model) {
      const model = this.modelRuntime.getModel(context.model.provider, context.model.modelId);
      if (model) session.agent.state.model = model;
    }
    session.agent.state.thinkingLevel = context.thinkingLevel as any;
  }

  async newSession(opts?: { parentSession?: string }): Promise<any> {
    return this.enqueueTransition(async () => {
      await this.ensureSession();
      await this.runtime.newSession({ parentSession: opts?.parentSession });
      const state = await this.getState();
      this.opts.onStatus({ status: "ready", cwd: this.cwd, sessionPath: state.sessionFile, state });
      return state;
    });
  }

  async switchTo(sessionPath: string, options?: any): Promise<any> {
    return this.enqueueTransition(async () => {
      await this.ensureSession();
      const r = await this.runtime.switchSession(sessionPath, options);
      await this.restoreActiveRollbackLeaf();
      const state = await this.getState();
      this.opts.onStatus({ status: "ready", cwd: this.cwd, sessionPath, state });
      return r;
    });
  }

  // -------------------------------------------------------------------------
  // Agent commands
  // -------------------------------------------------------------------------

  async prompt(message: string, images?: any[], streamingBehavior?: "steer" | "followUp"): Promise<any> {
    await this.ensureSession();
    const sessionAtStart = this.runtime.session;
    const rollbackAtStart = (await this.rollbacks.load(sessionAtStart.sessionId).catch(() => null))?.active;
    const entriesAtStart = entryDigest(sessionAtStart.sessionManager.getEntries());
    // Mid-stream steer/follow-up messages cannot establish a race-free
    // filesystem boundary. They remain part of the active checkpointed turn.
    const checkpoint = streamingBehavior ? null : await this.captureTurnStart();
    const opts: any = {};
    opts.images = toPiImages(images);
    if (streamingBehavior) opts.streamingBehavior = streamingBehavior;
    try {
      return await this.runtime.session.prompt(message, opts);
    } finally {
      if (rollbackAtStart && this.runtime.session.sessionId === rollbackAtStart.sessionId) {
        const continued =
          entryDigest(this.runtime.session.sessionManager.getEntries()) !== entriesAtStart ||
          this.runtime.session.sessionManager.getLeafId() !== rollbackAtStart.rollbackLeafId;
        if (continued) await this.rollbacks.clearActive(rollbackAtStart.sessionId).catch(() => undefined);
      }
      if (checkpoint) await this.captureTurnEnd(checkpoint).catch(() => undefined);
    }
  }
  async steer(message: string): Promise<any> {
    await this.ensureSession();
    await this.commitActiveRollback();
    return this.runtime.session.steer(message);
  }
  async followUp(message: string): Promise<any> {
    await this.ensureSession();
    await this.commitActiveRollback();
    return this.runtime.session.followUp(message);
  }
  async abort(): Promise<any> {
    await this.ensureSession();
    return this.runtime.session.abort();
  }
  async compact(customInstructions?: string): Promise<any> {
    return this.enqueueTransition(async () => {
      await this.ensureSession();
      const session = this.runtime.session;
      const before = entryDigest(session.sessionManager.getEntries());
      try {
        return await session.compact(customInstructions);
      } finally {
        if (entryDigest(session.sessionManager.getEntries()) !== before) await this.commitActiveRollback();
      }
    });
  }

  private async moveToExactLeaf(targetId: string | null): Promise<void> {
    const session = this.runtime.session;
    const manager = session.sessionManager;
    if (targetId === null) {
      manager.resetLeaf();
      session.agent.state.messages = manager.buildSessionContext().messages;
      return;
    }
    const target = manager.getEntry(targetId) as any;
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
    const session = this.runtime.session;
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
  } | null> {
    const session = this.runtime.session;
    const sessionFile = session.sessionFile ?? session.sessionManager.getSessionFile();
    if (!sessionFile || session.isStreaming) return null;
    const before = await this.snapshots.capture(this.cwd).catch(() => null);
    if (!before) return null;
    const entries = session.sessionManager.getEntries();
    return {
      sessionId: session.sessionId,
      sessionFile,
      beforeLeafId: session.sessionManager.getLeafId(),
      beforeEntryIds: new Set(entries.map((entry: any) => entry.id)),
      before,
    };
  }

  private async captureTurnEnd(start: {
    sessionId: string;
    sessionFile: string;
    beforeLeafId: string | null;
    beforeEntryIds: Set<string>;
    before: SnapshotCapture;
  }): Promise<void> {
    const session = this.runtime.session;
    const sessionFile = session.sessionFile ?? session.sessionManager.getSessionFile();
    if (session.sessionId !== start.sessionId || sessionFile !== start.sessionFile) return;
    const entries = session.sessionManager.getEntries() as any[];
    const user = entries.find(
      (entry) => !start.beforeEntryIds.has(entry.id) && entry.type === "message" && entry.message?.role === "user"
    );
    const finalLeafId = session.sessionManager.getLeafId();
    if (!user || !finalLeafId) return;
    const after = await this.snapshots.capture(this.cwd).catch(() => null);
    if (!after || after.root !== start.before.root) return;
    const changedPaths = await this.snapshots.changedFiles(this.cwd, start.before.tree, after.tree);
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
    await this.rollbacks.addCheckpoint(checkpoint);
    this.opts.onEvent({
      type: "pideck_history_changed",
      sessionId: start.sessionId,
      sessionFile: start.sessionFile,
    });
  }

  private async commitActiveRollback(): Promise<void> {
    const sessionId = this.runtime?.session?.sessionId;
    if (!sessionId) return;
    await this.rollbacks.clearActive(sessionId).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  async getState(): Promise<any> {
    await this.ensureSession();
    const s = this.runtime.session;
    return {
      model: s.model ?? null,
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
  async getMessages(): Promise<any[]> {
    await this.ensureSession();
    const messages = this.runtime.session.messages;
    const userEntries = this.runtime.session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.type === "message" && entry.message?.role === "user");
    let userIndex = 0;
    return messages.map((message: any) => {
      if (message?.role !== "user") return clampToolOutput(message);
      const entry = userEntries[userIndex++];
      return entry ? clampToolOutput({ ...message, entryId: entry.id }) : clampToolOutput(message);
    });
  }
  async getToolOutput(toolCallId: string): Promise<{ content: string; truncated: boolean }> {
    const file = this.runtime.session.sessionFile;
    if (!file) throw new Error("No session file for the active session");
    return readToolOutput(file, toolCallId);
  }
  async getStats(): Promise<any> {
    await this.ensureSession();
    return this.runtime.session.getSessionStats();
  }
  async getCommands(): Promise<Array<{ name: string; description?: string; argumentHint?: string; source: string }>> {
    await this.ensureSession();
    const extensionCommands = this.runtime.session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      description: command.description,
      source: "extension",
    }));
    const prompts = this.runtime.services.resourceLoader.getPrompts().prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      argumentHint: prompt.argumentHint,
      source: "prompt",
    }));
    const skills = this.runtime.services.resourceLoader.getSkills().skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill",
    }));
    const seen = new Set<string>();
    return [...extensionCommands, ...prompts, ...skills].filter((command) => {
      if (seen.has(command.name)) return false;
      seen.add(command.name);
      return true;
    });
  }
  async getModels(): Promise<any[]> {
    await this.ensureSession();
    const available = await this.runtime.services.modelRuntime.getAvailable();
    const overrides = getSettings().contextWindowOverrides ?? {};
    return [...available].map((m) => {
      const key = `${m.provider}/${m.id}`;
      const override = overrides[key];
      return typeof override === "number" && override > 0 ? { ...m, contextWindow: override } : m;
    }) as any[];
  }
  async setModel(provider: string, modelId: string): Promise<any> {
    return this.enqueueTransition(async () => {
      await this.ensureSession();
      const model = this.runtime.services.modelRuntime.getModel(provider, modelId);
      if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
      await this.runtime.session.setModel(model);
      await this.commitActiveRollback();
      return { model };
    });
  }
  async setThinking(level: string): Promise<any> {
    return this.enqueueTransition(async () => {
      await this.ensureSession();
      this.runtime.session.setThinkingLevel(level as any);
      await this.commitActiveRollback();
      return {};
    });
  }
  /** Read the user's Babylon preferences (model + reasoning + overrides). */
  async getSettings(): Promise<PiSettings> {
    return getSettings();
  }
  /** Merge + persist a patch of the user's Babylon preferences. */
  async setSettings(patch: Partial<PiSettings>): Promise<PiSettings> {
    return saveSettings(patch);
  }
  async getThinkingLevels(): Promise<string[]> {
    await this.ensureSession();
    try {
      const levels = (this.runtime.session as any).getAvailableThinkingLevels?.();
      return Array.isArray(levels) ? levels : [];
    } catch {
      return [];
    }
  }
  async setSessionName(name: string): Promise<any> {
    return this.enqueueTransition(async () => {
      await this.ensureSession();
      this.runtime.session.setSessionName(name);
      await this.commitActiveRollback();
      return {};
    });
  }

  // -------------------------------------------------------------------------
  // History, rollback, branching and worktrees
  // -------------------------------------------------------------------------

  async getHistory(): Promise<any> {
    await this.ensureSession();
    const session = this.runtime.session;
    const manager = session.sessionManager;
    const rows = flattenSessionTree(manager.getTree());
    const ledger = await this.rollbacks.load(session.sessionId).catch(() => ({ version: 1 as const, checkpoints: [], active: undefined }));
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
      gitAvailable: await this.snapshots.available(this.cwd),
      streaming: session.isStreaming,
      activeRollback: active,
      undoAvailable,
      undoReason,
    });
  }

  async getTurnChanges(entryId: string): Promise<any> {
    await this.ensureSession();
    const session = this.runtime.session;
    const ledger = await this.rollbacks.load(session.sessionId).catch(() => ({ version: 1 as const, checkpoints: [], active: undefined }));
    const checkpoint = ledger.checkpoints.find((item) => item.userEntryId === entryId);
    if (!checkpoint) throw new Error("No filesystem checkpoint was recorded for this turn");
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

  async getTurnFileDiff(entryId: string, path: string): Promise<any> {
    await this.ensureSession();
    const session = this.runtime.session;
    const ledger = await this.rollbacks.load(session.sessionId).catch(() => ({ version: 1 as const, checkpoints: [], active: undefined }));
    const checkpoint = ledger.checkpoints.find((item) => item.userEntryId === entryId);
    if (!checkpoint) throw new Error("No filesystem checkpoint was recorded for this turn");
    if (!checkpoint.complete) throw new Error("This filesystem checkpoint is incomplete");
    return this.snapshots.fileDiff(this.cwd, checkpoint.beforeTree, checkpoint.afterTree, path);
  }

  async prepareRollback(userEntryId: string): Promise<any> {
    await this.ensureSession();
    const session = this.runtime.session;
    if (session.isStreaming) throw new Error("Finish or stop the active response before rolling back");
    if (!session.sessionFile) throw new Error("Send at least one message before rolling back");
    const ledger = await this.rollbacks.load(session.sessionId);
    if (ledger.active) throw new Error("Undo or continue from the active rollback first");
    const branch = session.sessionManager.getBranch() as any[];
    const users = branch.filter((entry) => entry.type === "message" && entry.message?.role === "user");
    const targetIndex = users.findIndex((entry) => entry.id === userEntryId);
    if (targetIndex < 0) throw new Error("The selected turn is not on the active path");
    const checkpointByUser = new Map(ledger.checkpoints.map((checkpoint) => [checkpoint.userEntryId, checkpoint]));
    const selected = users.slice(targetIndex);
    const checkpoints = selected.map((entry) => checkpointByUser.get(entry.id));
    if (checkpoints.some((checkpoint) => !checkpoint)) throw new Error("No filesystem checkpoint was recorded for this turn");
    if (checkpoints.some((checkpoint) => !checkpoint!.complete)) throw new Error("This filesystem checkpoint is incomplete");
    const previousLeafId = session.sessionManager.getLeafId();
    if (!previousLeafId) throw new Error("No active session position");
    const redo = await this.snapshots.capture(this.cwd);
    if (!redo) throw new Error("Rollback requires a Git project");
    const restoreMap: Record<string, string> = Object.create(null);
    for (const checkpoint of checkpoints as TurnCheckpoint[]) {
      for (const path of checkpoint.changedPaths) {
        if (!Object.hasOwn(restoreMap, path)) restoreMap[path] = checkpoint.beforeTree;
      }
    }
    const changes = await this.snapshots.preview(this.cwd, redo.tree, restoreMap);
    const target = users[targetIndex];
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

  async commitRollback(planId: string): Promise<any> {
    return this.enqueueTransition(async () => {
      await this.ensureSession();
      const plan = this.rollbackPlans.get(planId);
      if (!plan || Date.now() - plan.createdAt > 10 * 60_000) throw new Error("The rollback preview expired; review it again");
      const session = this.runtime.session;
      const manager = session.sessionManager;
      if (session.isStreaming) throw new Error("Finish or stop the active response before rolling back");
      if (session.sessionId !== plan.sessionId || session.sessionFile !== plan.sessionFile) throw new Error("The active session changed");
      if (manager.getLeafId() !== plan.expectedLeafId || entryDigest(manager.getEntries()) !== plan.entryDigest) {
        throw new Error("The session changed; review the rollback again");
      }
      const current = await this.snapshots.capture(this.cwd);
      if (!current || current.tree !== plan.redo.tree) throw new Error("Project files changed; review the rollback again");
      await this.snapshots.restore(this.cwd, plan.restoreMap);
      let navigated = false;
      try {
        const target = manager.getEntry(plan.targetUserEntryId) as any;
        let editorText = plan.editorText;
        if (manager.getLeafId() === plan.targetUserEntryId && target?.type === "message" && target.message?.role === "user") {
          // Pi's navigateTree short-circuits when target === leaf before applying
          // its user-message "move to parent and edit" semantics.
          if (target.parentId === null) manager.resetLeaf();
          else manager.branch(target.parentId);
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

  async undoRollback(): Promise<any> {
    return this.enqueueTransition(async () => {
      await this.ensureSession();
      const session = this.runtime.session;
      const manager = session.sessionManager;
      const ledger = await this.rollbacks.load(session.sessionId);
      const active = ledger.active;
      if (!active) throw new Error("There is no rollback to undo");
      if (session.isStreaming) throw new Error("Finish or stop the active response before undoing rollback");
      if (session.sessionFile !== active.sessionFile || manager.getLeafId() !== active.rollbackLeafId || entryDigest(manager.getEntries()) !== active.entryDigest) {
        await this.rollbacks.clearActive(session.sessionId);
        throw new Error("Undo rollback is no longer available because the session continued");
      }
      const current = await this.snapshots.capture(this.cwd);
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

  async getTree(): Promise<any> {
    await this.ensureSession();
    const sm = this.runtime.session.sessionManager;
    return { rows: flattenSessionTree(sm.getTree()), leafId: sm.getLeafId() };
  }
  async getForkMessages(): Promise<any[]> {
    await this.ensureSession();
    return this.runtime.session.getUserMessagesForForking();
  }
  async fork(entryId: string): Promise<any> {
    return this.enqueueTransition(async () => {
      await this.ensureSession();
      const sourceSessionId = this.runtime.session.sessionId;
      const r = await this.runtime.fork(entryId);
      if (!r.cancelled) await this.rollbacks.clearActive(sourceSessionId).catch(() => undefined);
      return { text: r.selectedText, cancelled: r.cancelled };
    });
  }
  async clone(): Promise<any> {
    return this.enqueueTransition(async () => {
      await this.ensureSession();
      const sourceSessionId = this.runtime.session.sessionId;
      const leafId = this.runtime.session.sessionManager.getLeafId();
      if (!leafId) throw new Error("no current entry selected");
      const r = await this.runtime.fork(leafId, { position: "at" });
      if (!r.cancelled) await this.rollbacks.clearActive(sourceSessionId).catch(() => undefined);
      return { cancelled: r.cancelled };
    });
  }

  async controlThread(action: "steer" | "follow-up" | "stop", threadId: string, message?: string): Promise<any> {
    return this.threads.control(this.cwd, action, threadId, message);
  }

  async promoteThread(threadId: string): Promise<{ sessionFile: string; cwd: string; parentSessionFile: string | null }> {
    return this.threads.promote(this.cwd, threadId);
  }

  private async notifyThreadParent(
    thread: { threadId: string; name: string | null; parentSessionId: string | null },
    action: "steer" | "follow-up" | "stop",
    message?: string
  ): Promise<void> {
    if (!thread.parentSessionId || thread.parentSessionId !== this.runtime.session.sessionId) return;
    const label = thread.name ?? thread.threadId.slice(0, 8);
    const content =
      action === "stop"
        ? `[Babylon Thread Activity]\nThread ${label} was stopped from Activity.`
        : `[Babylon Thread Activity]\nThe user sent this ${action === "steer" ? "steering message" : "follow-up"} to thread ${label}:\n\n${message}`;
    await this.runtime.session.sendCustomMessage({
      customType: "babylon_thread_activity",
      content,
      display: true,
      details: { threadId: thread.threadId, action, message },
    });
  }

  /** Milestone-watching notifications: the main agent learns when a thread
   *  reaches a checkpoint, blocks, or finishes — without polling. */
  async notifyThreadEvent(thread: { threadId: string; name: string | null; parentSessionId?: string | null }, event: any): Promise<void> {
    if (!thread.parentSessionId || thread.parentSessionId !== this.runtime.session.sessionId) return;
    const label = thread.name ?? thread.threadId.slice(0, 8);
    let content: string;
    if (event?.type === "milestone") {
      const name = event.milestone?.name ?? "checkpoint";
      content = `[Babylon Thread Activity]\nThread ${label} reached a milestone — ${name}${event.milestone?.note ? `: ${event.milestone.note}` : ""}`;
    } else if (event?.type === "blocked") {
      content = `[Babylon Thread Activity]\nThread ${label} is blocked${event.blocker ? `: ${event.blocker}` : ""}.`;
    } else {
      const done = event?.status === "failed" ? "failed" : event?.status === "stopped" ? "was stopped" : "completed";
      content = `[Babylon Thread Activity]\nThread ${label} ${done}.`;
    }
    await this.runtime.session.sendCustomMessage({
      customType: "babylon_thread_activity",
      content,
      display: true,
      details: { threadId: thread.threadId, ...event },
    });
    // Custom messages emit no renderer event on their own; deliver a
    // message_start so the line appears in the visible chat immediately.
    this.opts.onEvent({
      type: "message_start",
      message: { role: "custom", customType: "babylon_thread_activity", content, display: true },
    });
  }

  private async notifySubagentParent(record: ManagedSubagentRecord, action: SubagentParentEvent, message?: string): Promise<void> {
    if (!record.parentSessionId || record.parentSessionId !== this.runtime.session.sessionId) return;
    const label = record.name ?? record.runId.slice(0, 8);
    const content = action === "stop"
      ? `[Babylon Subagent Activity]\nSubagent ${label} was stopped from Activity.`
      : action === "reply"
        ? `[Babylon Subagent Activity]\nSubagent ${label} replied:\n\n${message}`
        : `[Babylon Subagent Activity]\nThe user sent this ${action === "steer" ? "steering message" : "follow-up"} to subagent ${label}:\n\n${message}`;
    await this.runtime.session.sendCustomMessage({
      customType: "babylon_subagent_activity",
      content,
      display: true,
      details: { runId: record.runId, action, message },
    });
    // Surface custom messages in the visible chat (they emit no renderer event).
    this.opts.onEvent({
      type: "message_start",
      message: { role: "custom", customType: "babylon_subagent_activity", content, display: true },
    });
  }

  async controlSubagent(action: SubagentControlAction, runId: string, message?: string): Promise<any> {
    return this.managedSubagents.control(this.cwd, action, runId, message);
  }

  async promoteSubagent(runId: string): Promise<{ sessionFile: string; cwd: string; parentSessionFile: string | null }> {
    return this.managedSubagents.promote(this.cwd, runId);
  }

  async dispose(): Promise<void> {
    this.rejectAllUi(new Error("host disposed"));
    await this.managedSubagents?.dispose().catch(() => undefined);
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    try {
      await this.runtime?.dispose();
    } catch {
      /* ignore */
    }
  }
}
