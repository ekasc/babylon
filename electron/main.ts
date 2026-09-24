import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as net from "node:net";
import { existsSync, promises as fsp, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentEventBuffer } from "./event-buffer";
import { buildContextMenuTemplate } from "./context-menu";
import { registerGitIpc } from "./git-ipc";
import { registerCanvasIpc } from "./canvas-ipc";
import { registerRuntimeIpc } from "./runtime-ipc";
import { registerLspProcessIpc } from "./lsp-process-ipc";
import { registerSimIpc } from "./sim-ipc";
import { SimController } from "./sim-controller";
import { registerSessionRuntimeIpc } from "./session-runtime-ipc";
import { registerActivityIpc } from "./activity-ipc";
import type { IpcHandle } from "./ipc-handle";
import type { WorkflowsBridgeLike } from "./activity-ipc";
import { registerSessionsIpc } from "./sessions-ipc";
import { registerBotsIpc } from "./bots-ipc";
import { registerPermissionsIpc } from "./permissions-ipc";
import { registerWorktreeIpc } from "./worktree-ipc";
import { getSettings } from "./app-settings";
import { PiHost, defaultStateDir } from "./pi-host";
import { PermissionEngine, type AgentAction, type Risk } from "./permissions";
import { isTrustedRendererUrl } from "./navigation";
import type { AgentEvent, AgentState } from "../src/bridge";
import { wireOf } from "../src/store";
import { validateSessionPath } from "./session-path";
import { SessionIndex } from "./sessions";
import { ProcessManager, validateCwd } from "./process-manager";
import { TaskManager } from "./task-manager";
import { LspManager } from "./lsp-manager";
import { HookManager } from "./hook-manager";
import { AttentionManager } from "./attention-manager";
import { BotStore } from "./bots";
import { ProjectSettingsStore, projectHashForCwd } from "./project-settings";
import { ActivityRegistry } from "./activity";
import { resolveParentSessionFile } from "./threads";
import { buildBotSystemPrompt, buildDefaultBotSystemPrompt, buildGroupSystemPrompt, resolveSharedChatOrder } from "../src/bots";
import { driveRoomTurns } from "./room-driver";
import type { CompletionContract } from "../src/completion-contracts";
import { connectDaemonClient, type DaemonClient } from "../src/daemon-client";
import { createCoalescingWorker } from "../src/lib/coalescing-worker";
import { DAEMON_PROTOCOL_VERSION, shouldRetireDaemon, type DaemonAdvertised } from "../src/daemon-protocol";
import { readDaemonPid, retireDaemon, type RetirePort } from "./daemon-supervisor";
import { acquireLifecycleLock, releaseLifecycleLock, LifecycleLockedError, type LifecycleLock } from "./daemon-lock";
import { buildId } from "../src/build-info";
import { syncDaemonTray, TRAY_ICON_DATA_URL, type DaemonTrayHandle } from "./tray";
import { importLoginShellEnv } from "./shell-env";
import { resolveRuntime } from "./runtime-select";
import type { RuntimeFacade } from "../src/runtime-facade";

const DEV_SERVER = !!process.env.VITE_DEV_SERVER_URL;

// Dev and packaged builds must never share app state. userData holds the
// detached daemon's socket and snapshot, settings, window bounds, and Chromium
// storage (localStorage), so a shared path lets one build's daemon serve the
// other and lets two running builds clobber each other's persisted UI state.
//
// Gated on app.isPackaged rather than an env var: a packaged build must never
// be divertable to a different profile, or a released update would silently
// start against an empty profile and look like data loss.
// Must run before app.whenReady() and before any app.getPath("userData").
if (!app.isPackaged) app.setPath("userData", join(app.getPath("appData"), "Babylon Dev"));

// Pi engine session store, forked per instance under userData so two owners
// (dev and packaged, or two checkouts) never interleave turns into each
// other's transcripts. Auth, models, and billing stay shared under ~/.pi.
function sessionsRoot(): string {
  return join(app.getPath("userData"), "sessions");
}

// Babylon-owned runtime state (rollback snapshots/ledgers, recaps, compaction
// archives). The in-process host and the daemon must both point here: a split
// would strand rollback history and force a cold rollback shadow index (a full
// worktree hash) on every switch of runtime ownership.
const PI_STATE_ROOT = defaultStateDir();

// ---------------------------------------------------------------------------
// Window bounds persistence, dev restarts reopen at the same place instead
// of re-centering over the user's work.
// ---------------------------------------------------------------------------

function windowBoundsFile(): string {
  return join(app.getPath("userData"), "window-bounds.json");
}

function loadSavedBounds(): Electron.Rectangle | undefined {
  try {
    const raw = JSON.parse(readFileSync(windowBoundsFile(), "utf8"));
    const bounds = {
      x: Number(raw.x),
      y: Number(raw.y),
      width: Number(raw.width),
      height: Number(raw.height),
    };
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return undefined;
    // Ignore saved bounds that no longer intersect any display (unplugged
    // monitor) so the window can never reopen off-screen.
    const area = screen.getDisplayMatching(bounds).workArea;
    const overlaps =
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y;
    return overlaps ? bounds : undefined;
  } catch {
    return undefined;
  }
}

let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null;

function rememberBounds(): void {
  if (!win || win.isDestroyed()) return;
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = null;
    if (!win || win.isDestroyed()) return;
    void fsp.writeFile(windowBoundsFile(), JSON.stringify(win.getNormalBounds())).catch(() => undefined);
  }, 400);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const RENDERER_ENTRY = pathToFileURL(join(__dirname, "../dist/index.html")).href;

let win: BrowserWindow | null = null;
let host: PiHost | null = null;
let hostReady: Promise<void> | null = null;
let activeCwd = "";

// In-app browser simulator: single shared controller for the renderer IPC
// surface and the agent tools. Created once; the window is resolved lazily.
const simController = new SimController({
  getWindow: () => win,
  notify: (payload) => {
    try {
      win?.webContents.send("pideck:sim-event", payload);
    } catch {
      /* window gone */
    }
  },
});

// Babylon permission system (Phase 1).
let permissionEngine: PermissionEngine | null = null;
interface PendingApproval {
  action: AgentAction;
  risk: Risk;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Owning session id (exact, from the requesting hook). Renderer resolves
   *  it to a path for attribution; absent for legacy unattributed requests. */
  sessionId: string | null;
}
const pendingApprovals = new Map<string, PendingApproval>();

function notifyPermissionsChanged(): void {
  win?.webContents.send("pideck:permissions-changed", {
    mode: permissionEngine?.getMode() ?? "auto",
    rules: permissionEngine?.listRules() ?? [],
  });
}

/** Ask the renderer for an interactive approval decision. Fails closed (deny)
 *  if the user never responds. */
function requestApproval(action: AgentAction, risk: Risk, sessionId?: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = randomUUID();
    const timeoutMs = Number(process.env.PIDECK_APPROVAL_TIMEOUT_MS) || 15 * 60_000;
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      resolve(false);
    }, timeoutMs);
    pendingApprovals.set(id, { action, risk, resolve, timer, sessionId: sessionId ?? null });
    win?.webContents.send("pideck:approval-requested", { id, action, risk });
  });
}

/**
 * Network egress raised by the canvas. It is put through the same policy as any
 * other egress: an explicit deny holds, an explicit allow passes, and anything
 * else asks. With no engine loaded it asks rather than assuming.
 */
async function gateCanvasEgress(action: AgentAction): Promise<boolean> {
  const evaluation = permissionEngine?.evaluate(action);
  if (evaluation?.decision === "deny") return false;
  if (evaluation?.decision === "allow") return true;
  return requestApproval(action, evaluation?.risk ?? "high");
}

function resolveApproval(id: string, choice: "allow_once" | "allow_session" | "allow_always" | "deny"): void {
  const pending = pendingApprovals.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  const sessionId = pending.sessionId ?? null;
  pendingApprovals.delete(id);
  if (choice === "allow_once") {
    pending.resolve(true);
  } else if (choice === "deny") {
    permissionEngine?.addRule({
      category: pending.action.category,
      decision: "deny",
      scope: "session",
      sessionId: pending.sessionId ?? undefined,
      match: pending.action.command
        ? { commandPattern: pending.action.command }
        : pending.action.paths
          ? { pathGlob: pending.action.paths[0] }
          : undefined,
    });
    pending.resolve(false);
  } else {
    permissionEngine?.addRule({
      category: pending.action.category,
      decision: "allow",
      scope: choice === "allow_always" ? "always" : "session",
      sessionId: choice === "allow_always" ? undefined : (pending.sessionId ?? undefined),
      match: pending.action.command
        ? { commandPattern: pending.action.command }
        : pending.action.paths
          ? { pathGlob: pending.action.paths[0] }
          : undefined,
    });
    pending.resolve(true);
  }
  notifyPermissionsChanged();
  // Let the renderer drop the matching attention-inbox item. The owning
  // session travels along so background resolutions land on the right run.
  win?.webContents.send("pideck:approval-resolved", { id, choice, sessionId });
}
let workflowsBridge: WorkflowsBridgeLike | null = null;
/** Process-wide activity observation: live projects keep their own bridge,
 *  idle ones are pruned with frozen snapshots. Navigation only foregrounds;
 *  it never destroys tracking (see ActivityRegistry). */
let activityRegistry: ActivityRegistry | null = null;
const sessionIndex = new SessionIndex(sessionsRoot());
const processManager = new ProcessManager();
const taskManager = new TaskManager(processManager);
const lspManager = new LspManager();
const hookManager = new HookManager();
const attentionManager = new AttentionManager();
const botStore = new BotStore();
const projectSettings = new ProjectSettingsStore();
function broadcastBots(): void {
  win?.webContents.send("pideck:bots-update", botStore.list());
}
function broadcastGroups(): void {
  win?.webContents.send("pideck:groups-update", botStore.listGroups());
}
/** Project settings for a cwd, snapshotting the app-default on first open.
 *  Never touches the repo; identity is the exact folder path. */
function projectSettingsForCwd(cwd: string) {
  return projectSettings.getOrCreate(cwd, botStore.getDefaultBot());
}

/** Staffed employees for a project, skipping deleted bots (membership is
 *  reconciled on read so deletes never break opens). */
function projectTeam(memberIds: string[]): NonNullable<ReturnType<BotStore["get"]>>[] {
  return memberIds
    .map((id) => botStore.get(id))
    .filter((b): b is NonNullable<typeof b> => !!b);
}

/** Persona overlay for a session file: member chat, group room, project
 *  default, or none. Exactly one applies; daemon-owned opens never reach
 *  here (they return before overlay selection), so this never leaks an
 *  overlay into daemon mode. */
function overlayForSessionFile(file: string | null | undefined, cwd?: string): string | null {
  if (!file) return null;
  const mapped = botStore.findByProjectSessionFile(file);
  if (mapped?.bot) return buildBotSystemPrompt(mapped.bot, botStore.list());
  const bot = botStore.findBySessionFile(file);
  if (bot) return buildBotSystemPrompt(bot, botStore.list());
  const group = botStore.findGroupBySessionFile(file);
  if (group) {
    const members = group.memberIds
      .map((id) => botStore.get(id))
      .filter((b): b is NonNullable<typeof b> => !!b);
    if (members.length >= 2) return buildGroupSystemPrompt(group, members);
  }
  if (cwd) {
    try {
      const { settings } = projectSettingsForCwd(cwd);
      return buildDefaultBotSystemPrompt(settings.defaultBot, projectTeam(settings.memberIds));
    } catch {
      return null;
    }
  }
  return null;
}

/** Staffed extras for a shared (default-bot) project chat: @-mentioned members,
 *  or the full staff when the project opted into free-speak. Skipped for rooms,
 *  member 1:1s, staff-less projects, and quiet turns with no mentions, so
 *  unstated chats behave byte-for-byte as before. */
async function driveSharedChatExtras(sessionFile: string, userText: string): Promise<void> {
  const cwd = getHost().sessionCwdFor(sessionFile);
  if (!cwd) return;
  if (botStore.findGroupBySessionFile(sessionFile)) return;
  if (botStore.findByProjectSessionFile(sessionFile) || botStore.findBySessionFile(sessionFile)) return;
  const settings = projectSettings.get(cwd);
  if (!settings || settings.memberIds.length === 0) return;
  const members = projectTeam(settings.memberIds);
  if (members.length === 0) return;
  // Mention routing covers both sides of the just-settled turn: the user's
  // text AND the default bot's reply, so a quoted "@hands take over"
  // handoff actually dispatches instead of sitting inert in the transcript.
  const assistantText = lastAssistantText(await getRuntime().getMessages(sessionFile));
  const order = resolveSharedChatOrder(members, userText, assistantText, settings.freeSpeak === true);
  if (order.length === 0) return;
  await driveRoomTurns({ groupId: `project:${projectHashForCwd(cwd)}`, members, order, io: driveExtrasIO(sessionFile) });
}

/** Shared driver IO: serial prompts in the live session with visible presence.
 *  Used by group rooms and shared-chat extras alike. */
function driveExtrasIO(sessionFile: string) {
  const runtime = getRuntime();
  return {
    prompt: async (text: string) => {
      await runtime.prompt(text, undefined, undefined, sessionFile);
    },
    readReply: async () => lastAssistantText(await runtime.getMessages(sessionFile)),
    emit: (ev: Record<string, unknown> & { type: string }) => {
      try {
        getHost().emitRoomEvent(sessionFile, ev);
      } catch {}
    },
  };
}
/** New bot/room sessions have a canonical future path before first flush ,
 *  resolve them lexically (containment-checked) when the live host owns them. */
async function resolveCanonicalSessionFile(stored: string | null | undefined): Promise<string | undefined> {
  if (!stored) return undefined;
  let owned: string | null = null;
  try {
    owned = getHost().activeSessionFile;
  } catch {}
  if (owned && owned === stored) return owned;
  try {
    const validated = await validateSessionPath(sessionsRoot(), stored);
    if (!existsSync(validated)) return undefined;
    return validated;
  } catch {
    return undefined;
  }
}
/** Latest assistant text in a message list (best-effort; "" when absent). */
function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = wireOf(messages[i]);
    if (!m || m.role !== "assistant") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map((b) => (typeof b === "string" ? b : String(wireOf(b)?.text ?? ""))).join("");
    }
    return "";
  }
  return "";
}
const contracts = new Map<string, CompletionContract>();
let daemonClient: DaemonClient | null = null;
/** Authoritative runtime ownership. "daemon" only after a successful startup
 *  handshake; "local" when the daemon is disabled, missing, or unreachable at
 *  startup. This is intentionally NOT flipped by a transient disconnect, a
 *  daemon that blips and reconnects stays daemon-owned, it just can't be
 *  reached for a moment (`daemonConnected`). */
let runtimeOwner: "local" | "daemon" = "local";
/** Liveness of the daemon socket. Transient: drops on a blip, restored on
 *  reconnect. Never changes `runtimeOwner`. */
let daemonConnected = false;

/** Menu-bar presence. Exists if and only if the daemon socket is connected. */
let daemonTray: DaemonTrayHandle | null = null;

function showMainWindow(): void {
  const target =
    win && !win.isDestroyed() ? win : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!target) {
    createWindow();
    return;
  }
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

function syncTray(): void {
  // Headless verification has no display; a Tray would throw.
  if (process.env.PIDECK_HEADLESS === "1") {
    daemonTray?.destroy();
    daemonTray = null;
    return;
  }
  try {
    daemonTray = syncDaemonTray(daemonTray, {
      connected: daemonConnected,
      tooltip: "Babylon — daemon connected",
      create: () => {
        const image = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
        image.setTemplateImage(true);
        const tray = new Tray(image);
        return {
          destroy: () => tray.destroy(),
          setToolTip: (tip: string) => tray.setToolTip(tip),
          setContextMenu: (menu: unknown) => tray.setContextMenu(menu as Electron.Menu),
          popUpContextMenu: () => tray.popUpContextMenu(),
          onClick: (fn: () => void) => tray.on("click", fn),
        };
      },
      menu: () =>
        Menu.buildFromTemplate([
          { label: "Babylon · daemon connected", enabled: false },
          { type: "separator" },
          { label: "Show Babylon", click: () => showMainWindow() },
          { label: "Quit Babylon", click: () => app.quit() },
        ]),
    });
  } catch {
    daemonTray = null;
  }
}

function daemonPaths() {
  return {
    socketPath: join(app.getPath("userData"), "daemon.sock"),
    snapshotPath: join(app.getPath("userData"), "daemon-state.json"),
    pidPath: join(app.getPath("userData"), "daemon.pid"),
  };
}

/** Shared permission rule/mode store (Electron and the daemon must agree). */
function permissionDir(): string {
  return join(app.getPath("userData"), "pideck-state", "permissions");
}

function isDaemonEnabled(): boolean {
  return !!getSettings().daemon?.enabled;
}

function getRuntime(): RuntimeFacade {
  return resolveRuntime({ runtimeOwner, daemonClient, host, taskManager, attentionManager, hookManager, contracts });
}

function daemonOnly(): DaemonClient | null {
  return runtimeOwner === "daemon" && daemonConnected && daemonClient ? daemonClient : null;
}

/** Authority (not connectivity): true when the daemon owns the runtime.
 *  Use this for ownership decisions (which runtime/task/permission store is
 *  authoritative). `daemonOnly()` additionally requires a live socket and is
 *  only for operations that must execute on the daemon right now. */
function isDaemonOwned(): boolean {
  return runtimeOwner === "daemon";
}

/** Require a live daemon client when the daemon owns the runtime. If it is
 *  temporarily disconnected, fail explicitly rather than silently falling
 *  back to local state, local does not own the runtime and mutating it would
 *  corrupt the daemon's authoritative view. */
function requireDaemonClient(): DaemonClient {
  if (runtimeOwner !== "daemon") throw new Error("not in daemon mode");
  const client = daemonOnly();
  if (!client) throw new Error("daemon is reconnecting, try again shortly");
  return client;
}

/** Install the LSP notifier that delivers diagnostics to the daemon-owned
 *  PiHost. Called both at startup (when the socket is live) and on reconnect
 *  (when the socket was down at startup but came back later). */
function installDaemonNotifier(client: DaemonClient): void {
  lspManager.setPiNotifier((diagCwd, diagnostics) => {
    if (diagCwd !== activeCwd) return;
    client.request("pi.notifyDiagnostics", { cwd: diagCwd, diagnostics }).catch(() => {});
  });
}

/** Startup-time placeholder when the daemon owns the runtime but the socket
 *  isn't up yet. Installs no notifier at all (the daemon will receive
 *  diagnostics via the notifier that onConnectionChange wires up on
 *  reconnect). Never installs a local notifier in daemon-owned mode. */
function installDeferredDaemonNotifier(): void {
  lspManager.setPiNotifier(() => {
    // Drop diagnostics until the daemon socket is up. onConnectionChange
    // replaces this with installDaemonNotifier on the next connected event.
  });
}

async function daemonClientTasks(): Promise<import("../src/tasks").Task[]> {
  const client = daemonOnly();
  if (!client) return [];
  try {
    const res = await client.request("state.get", {});
    const runtime = (res.payload as { runtime?: { tasks?: { tasks: Record<string, import("../src/tasks").Task> } } })?.runtime;
    return Object.values(runtime?.tasks?.tasks ?? {});
  } catch {
    return [];
  }
}

/** Strict variant: takes a required live client and propagates request
 *  failures. Use for mutating/destructive ownership decisions (process-spawn,
 *  task-spawn, worktree-exit). A connected daemon that fails the request is
 *  NOT equivalent to "there are no tasks", the caller must surface the
 *  failure. */
async function daemonClientTasksStrict(client: import("../src/daemon-client").DaemonClient): Promise<import("../src/tasks").Task[]> {
  const res = await client.request("state.get", {});
  const runtime = (res.payload as { runtime?: { tasks?: { tasks: Record<string, import("../src/tasks").Task> } } })?.runtime;
  return Object.values(runtime?.tasks?.tasks ?? {});
}

async function daemonTaskBySessionFile(file: string | null | undefined): Promise<import("../src/tasks").Task | undefined> {
  if (!file) return undefined;
  const client = daemonOnly();
  if (!client) return undefined;
  const tasks = await daemonClientTasks();
  return tasks.find((t) => t.sessionFile === file);
}

async function daemonTaskBySessionFileStrict(
  client: import("../src/daemon-client").DaemonClient,
  file: string | null | undefined
): Promise<import("../src/tasks").Task | undefined> {
  if (!file) return undefined;
  const tasks = await daemonClientTasksStrict(client);
  return tasks.find((t) => t.sessionFile === file);
}

/** Active session file of the daemon-owned PiHost (daemon mode only). */
async function daemonActiveSessionFile(): Promise<string | null> {
  const client = daemonOnly();
  if (!client) return null;
  try {
    const res = await client.request("pi.getState", {});
    const sessionFile = (res.payload as { sessionFile?: string } | null)?.sessionFile;
    return typeof sessionFile === "string" && sessionFile.length > 0 ? sessionFile : null;
  } catch {
    return null;
  }
}

/** Strict variant of `daemonActiveSessionFile`: takes a required live
 *  client and propagates request failures. */
async function daemonActiveSessionFileStrict(client: import("../src/daemon-client").DaemonClient): Promise<string | null> {
  const res = await client.request("pi.getState", {});
  const sessionFile = (res.payload as { sessionFile?: string } | null)?.sessionFile;
  return typeof sessionFile === "string" && sessionFile.length > 0 ? sessionFile : null;
}
const agentEvents = new AgentEventBuffer((events) => {
  win?.webContents.send("pideck:agent-events", events);
});

/** Single ingestion point for live agent events, both runtimes. The buffer
 *  feeds the renderer; the registry routes ownership (and revives pruned
 *  idle bridges — without this, daemon-owned background work would never
 *  reappear in activity after pruning). Async by design: never block an
 *  event pump on ownership resolution. */
function ingestAgentEvent(ev: AgentEvent): void {
  agentEvents.push(ev);
  try {
    void activityRegistry?.observeAgentEvent(ev);
  } catch {
    /* best effort */
  }
}

// Task and attention broadcasts arrive in flurries, and each one used to cost
// a full state.get round-trip plus a full-list send. Latest wins per view:
// a burst collapses to the fewest refreshes possible.
const daemonViewRefresh = createCoalescingWorker<string, void>({
  merge: () => undefined,
  process: async (key) => {
    const res = await daemonClient?.request("state.get", {}).catch(() => null);
    if (!res) return;
    const runtime = (res.payload as { runtime?: { tasks?: { tasks: Record<string, unknown> }; attention?: unknown } })?.runtime;
    if (key === "tasks") {
      const tasks = runtime?.tasks ? Object.values(runtime.tasks.tasks) : [];
      win?.webContents.send("pideck:task-update", tasks);
    } else {
      win?.webContents.send("pideck:attention-update", runtime?.attention ?? { items: {} });
    }
  },
});

// ---------------------------------------------------------------------------
// Workflows bridge (pi-dynamic-workflows run state)
// ---------------------------------------------------------------------------

/** (Re)create the workflows bridge when the session cwd changes. */
function applyCwd(cwd: string): void {
  if (!cwd) return;
  activeCwd = cwd;
  taskManager.resumeForSession(host?.activeSessionFile);
  updateActivityBridge(cwd);
  // LSP: set active project; failures are best-effort (e.g. cwd deleted).
  void lspManager.setActiveProject(cwd).catch(() => undefined);
}

function updateActivityBridge(cwd: string): void {
  // Foreground a project for tracking. Projects with live work keep polling
  // regardless of focus; idle ones are pruned (see ActivityRegistry) — either
  // way, switching projects changes what Babylon displays, never what it
  // believes is still running.
  if (!cwd) return;
  try {
    if (!activityRegistry) {
      activityRegistry = new ActivityRegistry({
        onUpdate: (update) => {
          // Windows may all be closed on macOS while the host (and polling)
          // stays alive: never send into a destroyed webContents.
          try {
            if (win && !win.isDestroyed()) win.webContents.send("pideck:activity-update", update);
          } catch {
            /* best effort */
          }
        },
        resolveParentSessionFile: (sessionId) => resolveParentSessionFile(sessionId, sessionsRoot()),
        // Session file -> owning project so live events route by ownership,
        // not UI focus. Index first (sync, cached), then task registries.
        resolveEventCwd: async (sessionFile) =>
          sessionIndex.cwdForSessionFile(sessionFile) ??
          taskManager.findBySessionFile(sessionFile)?.cwd ??
          (await daemonTaskBySessionFile(sessionFile).catch(() => undefined))?.cwd ??
          null,
      });
    }
    activityRegistry.ensure(cwd);
  } catch {
    /* best effort; the renderer keeps its event-layer state */
  }
}

// ---------------------------------------------------------------------------
// Window + status
// ---------------------------------------------------------------------------

function createWindow(): void {
  // Headless mode (PIDECK_HEADLESS=1) runs the full renderer for automated
  // verification without ever showing a window, so dev/testing never disturbs
  // the user's screen.
  const headless = process.env.PIDECK_HEADLESS === "1";
  win = new BrowserWindow({
    ...(loadSavedBounds() ?? { width: 1280, height: 840 }),
    minWidth: 940,
    minHeight: 620,
    // Under the dev server the window appears only after first paint and via
    // showInactive(), so watcher restarts never steal focus or cover the
    // screen the user is working in.
    show: !headless && !DEV_SERVER,
    title: "Babylon",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Center the lights on the 64px titlebar line (y + 12/2 = 32) and keep
    // clear of the header content that starts at 88px.
    trafficLightPosition: { x: 12, y: 16 },
    backgroundColor: "#161616",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  // "local-fonts" is sent by newer Chromium but missing from Electron's
  // Permission union: compare the string form instead of extending theirs.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    if (String(permission) === "local-fonts") callback(true);
    else callback(false);
  });
  // Some Chromium builds also gate local-fonts behind a check handler
  try {
    win.webContents.session.setPermissionCheckHandler?.((_wc, permission) => String(permission) === "local-fonts");
  } catch {}
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Native right-click menu: standard edit actions in text fields, Copy on
  // transcript selections, nothing on empty chrome. Regions with their own
  // React menu (sidebar session rows) preventDefault the DOM event, which
  // suppresses this request, so the two never double up.
  win.webContents.on("context-menu", (_event, params) => {
    if (!win || win.isDestroyed()) return;
    const template = buildContextMenuTemplate(params, app.isPackaged, {
      inspectAt: (x, y) => win?.webContents.inspectElement(x, y),
    });
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, devUrl, RENDERER_ENTRY)) event.preventDefault();
  });
  // Renderer reloads (Cmd+R, Vite full-reload) destroy React without running
  // unmount cleanups, so SimSidebar's simDetach never fires and the guests
  // keep painting over the fresh UI. Detach on every load; the sidebar
  // re-binds its slot when it remounts.
  win.webContents.on("did-finish-load", () => {
    try {
      simController.detachAll();
    } catch {
      /* controller gone */
    }
  });

  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "../dist/index.html"));
  }
  win.on("closed", () => {
    win = null;
  });
  win.on("move", rememberBounds);
  win.on("resize", rememberBounds);
  if (!headless && DEV_SERVER) {
    win.once("ready-to-show", () => win?.showInactive());
  }
  if (devUrl) {
    // Keep renderer diagnostics visible during development only. Production
    // output may contain prompts/tool data and should not be mirrored to logs.
    // Electron delivers level/message as dedicated listener args (not on the
    // event object); reading them positionally restores the actual text.
    win.webContents.on("console-message", (_event, level, message) => {
      const tag =
        level === 0 ? "debug" : level === 1 ? "log" : level === 2 ? "warn" : level === 3 ? "error" : "info";
      console.log(`[renderer:${tag}] ${message}`);
    });
  }
}

function sendStatus(status: string, extra: Record<string, unknown> = {}): void {
  win?.webContents.send("pideck:session-status", { status, cwd: activeCwd, ...extra });
}

// ---------------------------------------------------------------------------
// pi host lifecycle
// ---------------------------------------------------------------------------

function getHost(): PiHost {
  if (!host) throw new Error("pi host not started");
  return host;
}

async function startHost(): Promise<void> {
  if (host) return;
  sendStatus("starting");
  try {
    const groups = await sessionIndex.list();
    const latest = groups.flatMap((g) => g.sessions).sort((a, b) => b.mtime - a.mtime)[0];
    const cwd = latest?.cwd ?? homedir();
    activeCwd = cwd;
    // Babylon permission system: load persistent rules + mode once, outside any
    // Pi session file, so policy survives restarts and is shared across projects.
    const permissionDir = join(app.getPath("userData"), "pideck-state", "permissions");
    permissionEngine = new PermissionEngine({ dir: permissionDir });
    await permissionEngine.load();
    if (isDaemonOwned()) {
      const client = daemonOnly();
      if (client) {
        const alive = await new Promise<boolean>((resolve) => {
          const probe = net.connect(daemonPaths().socketPath);
          probe.once("connect", () => { probe.destroy(); resolve(true); });
          probe.once("error", () => resolve(false));
        });
        if (alive) {
          console.log("[pideck] pi host is daemon-owned (thin client)");
          return;
        }
      }
      // Owned by the daemon but the socket is down. Do NOT fall back to an
      // in-process host: a local host would shadow the daemon after reconnect
      // and split task/attention state. Wait for the socket to re-establish.
      console.warn("[pideck] daemon owns the runtime but the socket is down; awaiting reconnection, no local host");
      return;
    }
    host = new PiHost({
      cwd,
      stateDir: PI_STATE_ROOT,
      sessionsRoot: sessionsRoot(),
      permission: permissionEngine
        ? {
            evaluate: (action, sessionId) => permissionEngine!.evaluate(action, sessionId),
            requestApproval,
            clearSessionRules: (sessionId) => permissionEngine!.clearSessionRules(sessionId),
            getMode: () => permissionEngine!.getMode(),
            listRules: () => permissionEngine!.listRules(),
          }
        : undefined,
      hookManager,
      getTaskIdForSessionFile: (file) => taskManager.findBySessionFile(file)?.id,
      getBotIdForSessionFile: (file) => botStore.findBySessionFile(file)?.id,
      getSimController: () => simController,
      onEvent: (ev: AgentEvent) => {
        // Transient subagent rows (tool start/end) ride the same event flow
        // the renderer already consumes; the registry routes each event to
        // its owning project by session file.
        ingestAgentEvent(ev);
        if (ev?.type === "message_end" || ev?.type === "agent_settled" || ev?.type === "session_info_changed") {
          sessionIndex.touch();
        }
      },
      onExecutionChanged: (execution) => {
        // Ownership push: merges into the renderer registry only — never
        // selects/opens/navigates a transcript.
        try {
          if (win && !win.isDestroyed()) win.webContents.send("pideck_execution_changed", execution);
        } catch {
          /* best effort */
        }
      },
      onStatus: (s: { status: string; message?: string; cwd?: string; sessionPath?: string; requestId?: number; state?: AgentState | null }) => {
        if (s?.cwd) applyCwd(s.cwd);
        // Forward requestId: the renderer matches ready/error against its
        // latest open to ignore stale switches. Dropping it deadens that
        // guard and lets an old ready rebind the live session id.
        sendStatus(s.status, { state: s.state, sessionPath: s.sessionPath, requestId: s.requestId });
      },
    });
    await host.start();
    // Wire LSP -> Pi diagnostics delivery (bounded, newly introduced only).
    lspManager.setPiNotifier((diagCwd, diagnostics) => {
      if (diagCwd !== activeCwd) return;
      try {
        host!.notifyDiagnostics(diagCwd, diagnostics);
      } catch {}
    });
    applyCwd(activeCwd);
    // Warm but invisible, the user hasn't opened a session yet.
    console.log("[pideck] pi host ready (in-process)");
  } catch (err) {
    host = null;
    sendStatus("error", { message: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// IPC (pideck:* channels, same surface as before; renderer unchanged)
// ---------------------------------------------------------------------------

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? event.sender.getURL();
  const devOrigin = process.env.VITE_DEV_SERVER_URL;
  const trusted = isTrustedRendererUrl(url, devOrigin, RENDERER_ENTRY);
  if (!trusted || event.sender !== win?.webContents) throw new Error("untrusted IPC sender");
}

function registerIpc(): void {
  const handle: IpcHandle = <A extends unknown[]>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: A) => unknown
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event);
      return listener(event, ...(args as A));
    });
  };

  registerSessionsIpc(handle, {
    sessionsRoot: sessionsRoot(),
    sessionIndex,
    getRuntime,
    getHost,
    isDaemonOwned,
    requireDaemonClient,
    daemonTaskBySessionFile,
    getWindow: () => win,
    getHostReady: () => hostReady,
    botStore,
    overlayForSessionFile,
    taskManager,
  });

  registerBotsIpc(handle, {
    sessionsRoot: sessionsRoot(),
    botStore,
    projectSettings,
    sessionIndex,
    taskManager,
    getRuntime,
    getHost,
    isDaemonOwned,
    getHostReady: () => hostReady,
    getActiveCwd: () => activeCwd,
    broadcastBots,
    broadcastGroups,
    projectSettingsForCwd,
    resolveCanonicalSessionFile,
    overlayForSessionFile,
    driveExtrasIO,
    lastAssistantText,
  });

  registerSessionRuntimeIpc(handle, {
    sessionsRoot: sessionsRoot(),
    getRuntime,
    getHost,
    isDaemonOwned,
    requireDaemonClient,
    driveSharedChatExtras,
  });
  registerGitIpc(handle, { getRuntime });

  registerCanvasIpc(handle, {
    getWindow: () => win,
    classifyRegions: (cwd, crops) => getHost().classifyRegions(cwd, crops),
    requestEgressApproval: gateCanvasEgress,
  });

  registerRuntimeIpc(handle, { getRuntime, daemonOnly, getWindow: () => win, getHostReady: () => hostReady });

  registerWorktreeIpc(handle, {
    getRuntime,
    isDaemonOwned,
    daemonOnly,
    requireDaemonClient,
    daemonTaskBySessionFile,
    daemonTaskBySessionFileStrict,
    taskManager,
    processManager,
    getActiveCwd: () => activeCwd,
    applyCwd,
    sendStatus,
  });

  registerPermissionsIpc(handle, {
    getPermissionEngine: () => permissionEngine,
    pendingApprovals,
    notifyPermissionsChanged,
    resolveApproval,
    isDaemonOwned,
    requireDaemonClient,
    getWindow: () => win,
  });

  registerActivityIpc(handle, {
    getRuntime,
    getActivityRegistry: () => activityRegistry,
    getWorkflowsBridge: () => workflowsBridge,
  });

  registerLspProcessIpc(handle, {
    lspManager,
    processManager,
    taskManager,
    getHost: () => host,
    isDaemonOwned,
    requireDaemonClient,
    daemonActiveSessionFileStrict,
    daemonTaskBySessionFileStrict,
    daemonClientTasksStrict,
    getWindow: () => win,
  });

  registerSimIpc(handle, {
    getSimController: () => simController,
  });
}

// ---------------------------------------------------------------------------
// Babylon daemon (Phase 6)
// ---------------------------------------------------------------------------

/**
 * Spawn the standalone daemon when the user enabled it. The daemon outlives
 * the GUI: it is detached and never killed on quit, so background execution
 * keeps running after the window closes. A daemon that already answers on the
 * socket is reused, but only when it speaks this build's protocol: an app
 * update does not replace the running daemon, so an incompatible one must be
 * retired rather than fed requests it cannot answer.
 */

/** True when something is listening on the unix socket right now. */
function probeSocket(socketPath: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
    setTimeout(() => {
      probe.destroy();
      resolve(false);
    }, timeoutMs);
  });
}

/** What the socket holder advertises, or undefined when it is
 *  unreachable or predates versioned handshakes. */
async function daemonAdvertised(socketPath: string): Promise<DaemonAdvertised | undefined> {
  const probe = connectDaemonClient({ listen: { socketPath }, reconnect: false });
  try {
    const res = await probe.request("ping", { protocol: DAEMON_PROTOCOL_VERSION }, 2_000);
    const payload = res.payload as DaemonAdvertised;
    if (typeof payload?.protocol !== "number") return undefined;
    return { protocol: payload.protocol, build: typeof payload.build === "string" ? payload.build : undefined };
  } catch {
    return undefined;
  } finally {
    probe.close();
  }
}

/** Ask a mismatched daemon to exit and, if it refuses, force it out by the pid
 *  it recorded at startup. Returns false when it could not be removed. */
const retirePort: RetirePort = {
  probe: probeSocket,
  requestShutdown: async (socketPath) => {
    const client = connectDaemonClient({ listen: { socketPath }, reconnect: false });
    try {
      await client.request("daemon.shutdown", {}, 2_000);
    } finally {
      client.close();
    }
  },
  signal: (pid, signal) => process.kill(pid, signal),
  readPidFile: readDaemonPid,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (message) => console.warn(message),
};

function spawnDaemon(entry: string, socketPath: string, snapshotPath: string, pidPath: string): void {
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      BABYLON_DAEMON_SOCKET: socketPath,
      BABYLON_DAEMON_SNAPSHOT: snapshotPath,
      BABYLON_DAEMON_PID_FILE: pidPath,
      BABYLON_DAEMON_STATE_DIR: PI_STATE_ROOT,
      BABYLON_SESSIONS_ROOT: sessionsRoot(),
      BABYLON_DAEMON_PERMISSIONS_DIR: permissionDir(),
      BABYLON_SETTINGS_PATH: app.getPath("userData") + "/pideck-settings.json",
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function ensureDaemon(): Promise<boolean> {
  if (!isDaemonEnabled()) return false;
  const { socketPath, snapshotPath, pidPath } = daemonPaths();
  const entry = join(__dirname, "..", "dist-daemon", "main.mjs");
  const entryExists = existsSync(entry);

  // Elect the holder under lock: two GUIs starting at once must not both see
  // an empty socket and both spawn. A loser waits briefly, then adopts.
  const lockPath = join(app.getPath("userData"), "daemon.lifecycle-lock");
  let lock: LifecycleLock | null = null;
  for (let i = 0; i < 3 && !lock; i++) {
    try {
      lock = await acquireLifecycleLock(lockPath);
    } catch (error) {
      if (!(error instanceof LifecycleLockedError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!lock) {
    console.error("[pideck] daemon election stayed locked; falling back to the in-process host");
    return false;
  }
  try {
    if (await probeSocket(socketPath)) {
      const running = await daemonAdvertised(socketPath);
      const ours = { protocol: DAEMON_PROTOCOL_VERSION, build: buildId() };
      if (shouldRetireDaemon(running, ours)) {
        console.warn(
          `[pideck] daemon is stale (protocol ${String(running?.protocol ?? "unknown")}, build ${String(running?.build ?? "unknown")}) vs this build (protocol ${ours.protocol}, build ${ours.build}); retiring it`
        );
        if (!(await retireDaemon(socketPath, pidPath, retirePort))) {
          // Fail closed: speaking a mismatched protocol risks corrupting the
          // daemon's authoritative state, so use the in-process host instead.
          console.error("[pideck] could not retire the incompatible daemon; falling back to the in-process host");
          return false;
        }
      }
    }

    if (!(await probeSocket(socketPath))) {
      if (!entryExists) {
        console.warn("daemon.enabled is set but dist-daemon/main.mjs is missing; run pnpm build:daemon, falling back to in-process host");
        return false;
      }
      spawnDaemon(entry, socketPath, snapshotPath, pidPath);
    }
  } finally {
    await releaseLifecycleLock(lock).catch(() => undefined);
  }
  if (!daemonClient) {
    daemonClient = connectDaemonClient({
      listen: { socketPath },
      reconnect: { initialDelayMs: 100, maxDelayMs: 5000 },
      // Without this the transport's own failures (an oversized frame, a bad
      // envelope) are swallowed and the reconnect loop looks unexplained.
      log: (message) => console.warn(`[pideck] daemon: ${message}`),
    });
    // Track daemon liveness. The socket-level connection callback is the
    // source of truth (not a protocol event). It only flips `daemonConnected`;
    // `runtimeOwner` is set once by the startup handshake and is never
    // surrendered on a transient blip. We keep the observer so `daemonOnly()`
    // and the UI stop reaching the daemon during an outage and resume on
    // reconnect without ever concluding we are in local mode.
    daemonClient.onConnectionChange((state) => {
      // A blip must not surrender runtime ownership to the local host; it
      // only marks the socket unreachable until the client reconnects.
      const wasConnected = daemonConnected;
      daemonConnected = state === "connected";
      // The renderer reconciles ephemeral runtime state on transitions (drop
      // non-active entries on reconnect; warn on loss). Guarded: windows may
      // be gone while the client lives on.
      try {
        if (win && !win.isDestroyed()) {
          win.webContents.send("pideck:daemon-status", { connected: daemonConnected });
        }
      } catch {
        /* best effort */
      }
      syncTray();
      // If the daemon owns the runtime and the socket just came back, install
      // the daemon LSP notifier (it was deferred at startup if the socket
      // happened to be down at that exact moment).
      if (!wasConnected && daemonConnected && isDaemonOwned()) {
        installDaemonNotifier(daemonClient!);
      }
    });
    daemonClient.onEvent((envelope) => {
      // Only forward daemon events when the daemon actually owns the runtime.
      // If Babylon fell back to local mode, a later daemon reconnect must not
      // inject daemon state into the locally-owned UI (P1 #6).
      if (!isDaemonOwned()) return;
      if (envelope.type === "task.created" || envelope.type === "task.updated" || envelope.type === "task.removed") {
        daemonViewRefresh.enqueue("tasks", undefined);
      }
      if (envelope.type === "attention.raised" || envelope.type === "attention.resolved") {
        daemonViewRefresh.enqueue("attention", undefined);
      }
      if (envelope.type === "pi.executionChanged") {
        // Daemon-owned execution ownership push: structural check before it
        // reaches the renderer registry (corrupt payloads are dropped).
        const p = envelope.payload;
        if (
          p !== null &&
          typeof p === "object" &&
          typeof (p as { cwd?: unknown }).cwd === "string" &&
          typeof (p as { sessionFile?: unknown }).sessionFile === "string" &&
          typeof (p as { sessionId?: unknown }).sessionId === "string" &&
          typeof (p as { state?: unknown }).state === "string" &&
          typeof (p as { streaming?: unknown }).streaming === "boolean" &&
          typeof (p as { generation?: unknown }).generation === "number"
        ) {
          try {
            if (win && !win.isDestroyed()) win.webContents.send("pideck_execution_changed", p);
          } catch {
            /* best effort */
          }
        }
      }
      if (envelope.type === "pi.event") {
        // The daemon forwards host agent events; only typed payloads enter
        // the local event buffer (anything else is a protocol violation).
        // Same ingestion as the local host: buffer + registry routing, so
        // daemon-owned background work revives pruned bridges too.
        const payload = envelope.payload;
        if (typeof payload === "object" && payload !== null && typeof (payload as { type?: unknown }).type === "string") {
          ingestAgentEvent(payload as AgentEvent);
        }
      }
      if (envelope.type === "pi.session.status") {
        // In daemon mode there is no local PiHost whose onStatus would call
        // applyCwd, so the thin client must sync the active cwd (and thus LSP
        // + git, which the Electron process still owns) from the daemon's
        // status broadcast before forwarding it to the renderer.
        const status = envelope.payload as { cwd?: string };
        if (status.cwd) applyCwd(status.cwd);
        win?.webContents.send("pideck:session-status", envelope.payload);
      }
      if (envelope.type === "approval.requested") {
        win?.webContents.send("pideck:approval-requested", envelope.payload);
      }
      if (envelope.type === "approval.cleared") {
        win?.webContents.send("pideck:approval-cleared", envelope.payload);
      }
      if (envelope.type === "permissions.changed") {
        win?.webContents.send("pideck:permissions-changed", envelope.payload);
      }
    });
  }
  return handshakeDaemon();
}

/** Awaitable handshake: resolves to true once the daemon is connected and
 *  round-trips a ping. Resolves to false (does not throw) when the daemon
 *  is disabled, the binary is missing, the socket is refused, or the ping
 *  times out. Either way, on return the caller can read `runtimeOwner` and
 *  `daemonOnly()` and pick local vs. daemon ownership without racing. */
async function handshakeDaemon(): Promise<boolean> {
  if (!isDaemonEnabled() || !daemonClient) return false;
  try {
    const pong = await daemonClient.request("ping", { protocol: DAEMON_PROTOCOL_VERSION }, 5_000);
    // ensureDaemon() should have retired a mismatched daemon already; this is
    // the last line of defense, including against a stale bundle respawned
    // from disk after the retire.
    const advertised = pong.payload as DaemonAdvertised;
    const ours = buildId();
    if (advertised?.protocol !== DAEMON_PROTOCOL_VERSION || (ours !== "unknown" && advertised?.build !== ours)) {
      console.error("[pideck] daemon skew during handshake (stale bundle on disk? run pnpm build:daemon); falling back to the in-process host");
      return false;
    }
  } catch {
    return false;
  }
  runtimeOwner = "daemon";
  daemonConnected = true;
  syncTray();
  // Warm the task cache so the UI has something to render immediately.
  daemonClient
    .request("state.get", {})
    .then((res) => {
      const runtime = (res.payload as { runtime?: { tasks?: { tasks: Record<string, unknown> } } })?.runtime;
      const tasks = runtime?.tasks ? Object.values(runtime.tasks.tasks) : [];
      win?.webContents.send("pideck:task-update", tasks);
    })
    .catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  // Source the login shell's environment before any child process is spawned.
  // A Finder-launched app inherits the minimal GUI environment, so without this
  // the agent's shell tool, git, and language servers cannot see homebrew,
  // fnm/asdf, or JAVA_HOME/GOPATH-style variables. Runs after createWindow so
  // the delay never holds up the window, and before ensureDaemon/startHost so
  // they inherit the fixed environment.
  await importLoginShellEnv();
  // ensureDaemon() awaits the initial ping handshake, so by the time it
  // returns, `runtimeOwner` is authoritative ("daemon" only when the daemon
  // round-tripped a ping; "local" on a missing binary, refused socket, or
  // timed-out ping). No split-brain: we choose local vs daemon ownership
  // here, once, and start exactly one host. A later transient disconnect
  // flips `daemonConnected` but never reverts `runtimeOwner`.
  await ensureDaemon();
  // Bots are local-runtime state in v1 (daemon owns tasks/attention when
  // active, but bot chats need the in-process host for persona overlays).
  botStore.subscribe((bots) => win?.webContents.send("pideck:bots-update", bots));
  botStore.subscribeGroups((groups) => win?.webContents.send("pideck:groups-update", groups));
  if (isDaemonOwned()) {
    // Daemon owns tasks and attention when active, thin client, no local subscriptions
    sessionIndex.subscribe((update) => win?.webContents.send("pideck:sessions-update", update));
  } else {
    processManager.subscribe((snapshots) => win?.webContents.send("pideck:process-update", snapshots));
    taskManager.subscribe((tasks) => win?.webContents.send("pideck:task-update", tasks));
    hookManager.subscribe((registry) => win?.webContents.send("pideck:hooks-update", registry));
    attentionManager.subscribe((registry) => win?.webContents.send("pideck:attention-update", registry));
    sessionIndex.subscribe((update) => win?.webContents.send("pideck:sessions-update", update));
  }
  if (isDaemonOwned()) {
    // Owner is the daemon. If the socket is live, install the daemon
    // notifier. If the socket is down at this instant, do NOT install the
    // local notifier, there is no local host to receive diagnostics, and
    // instead install a notifier on reconnect (handled by the
    // onConnectionChange hook below).
    const notifierClient = daemonOnly();
    if (notifierClient) installDaemonNotifier(notifierClient);
    else installDeferredDaemonNotifier();
  } else {
    lspManager.setPiNotifier((diagCwd, diagnostics) => {
      if (diagCwd !== activeCwd) return;
      try {
        host!.notifyDiagnostics(diagCwd, diagnostics);
      } catch {}
    });
  }
  hostReady = startHost();
  // Smoke-test hook: PIDECK_SMOKE=<ms> auto-quits after a delay.
  if (process.env.PIDECK_SMOKE) {
    setTimeout(() => app.quit(), Number(process.env.PIDECK_SMOKE)).unref();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // On macOS the process remains alive and a later Dock activation creates a
  // new window. Keep the shared host alive there; disposing it made the new
  // window reconnect to a dead runtime.
  if (process.platform !== "darwin") {
    lspManager.dispose();
    processManager.dispose();
    sessionIndex.dispose();
    activityRegistry?.disposeAll();
    activityRegistry = null;
    void host?.dispose();
    app.quit();
  }
});

app.on("before-quit", () => {
  daemonTray?.destroy();
  daemonTray = null;
  // Flush window bounds synchronously; the debounced writer may not have run.
  try {
    if (win && !win.isDestroyed()) writeFileSync(windowBoundsFile(), JSON.stringify(win.getNormalBounds()));
  } catch {
    /* best effort */
  }
  agentEvents.dispose();
  lspManager.dispose();
  processManager.dispose();
  sessionIndex.dispose();
  activityRegistry?.disposeAll();
    activityRegistry = null;
  void host?.dispose();
});
