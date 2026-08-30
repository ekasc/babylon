import { app, BrowserWindow, dialog, ipcMain, screen, shell, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import * as net from "node:net";
import { existsSync, promises as fsp, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { AgentEventBuffer } from "./event-buffer";
import * as gitOps from "./git";
import { getSettings } from "./app-settings";
import { PiHost } from "./pi-host";
import { PermissionEngine, type AgentAction, type Risk } from "./permissions";
import { mergeRecaps, mergeRecapsIntoWindow } from "./recap";
import { isTrustedRendererUrl } from "./navigation";
import { validateSessionPath } from "./session-path";
import { SessionIndex, readSessionRange, readSessionTail } from "./sessions";
import { ProcessManager, validateCommand, validateCwd, validateId } from "./process-manager";
import { TaskManager } from "./task-manager";
import { LspManager, validateCwd as validateLspCwd } from "./lsp-manager";
import { HookManager } from "./hook-manager";
import { AttentionManager } from "./attention-manager";
import { type CheckResult, type CompletionContract } from "../src/completion-contracts";
import { connectDaemonClient, type DaemonClient } from "../src/daemon-client";
import { createLocalRuntime } from "../src/local-runtime";
import { createDaemonRuntime } from "../src/daemon-runtime";
import type { RuntimeFacade } from "../src/runtime-facade";

// Pi engine session store (mirrors electron/threads.ts).
const PI_SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

const DEV_SERVER = !!process.env.VITE_DEV_SERVER_URL;

// ---------------------------------------------------------------------------
// Window bounds persistence — dev restarts reopen at the same place instead
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

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const RENDERER_ENTRY = pathToFileURL(join(__dirname, "../dist/index.html")).href;

let win: BrowserWindow | null = null;
let host: PiHost | null = null;
let hostReady: Promise<void> | null = null;
let activeCwd = "";

// Babylon permission system (Phase 1).
let permissionEngine: PermissionEngine | null = null;
interface PendingApproval {
  action: AgentAction;
  risk: Risk;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
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
function requestApproval(action: AgentAction, risk: Risk): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = randomUUID();
    const timeoutMs = Number(process.env.PIDECK_APPROVAL_TIMEOUT_MS) || 15 * 60_000;
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      resolve(false);
    }, timeoutMs);
    pendingApprovals.set(id, { action, risk, resolve, timer });
    win?.webContents.send("pideck:approval-requested", { id, action, risk });
  });
}

function resolveApproval(id: string, choice: "allow_once" | "allow_session" | "allow_always" | "deny"): void {
  const pending = pendingApprovals.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingApprovals.delete(id);
  if (choice === "allow_once") {
    pending.resolve(true);
  } else if (choice === "deny") {
    permissionEngine?.addRule({
      category: pending.action.category,
      decision: "deny",
      scope: "session",
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
      match: pending.action.command
        ? { commandPattern: pending.action.command }
        : pending.action.paths
          ? { pathGlob: pending.action.paths[0] }
          : undefined,
    });
    pending.resolve(true);
  }
  notifyPermissionsChanged();
  // Let the renderer drop the matching attention-inbox item.
  win?.webContents.send("pideck:approval-resolved", { id, choice });
}
let workflowsBridge: any = null;
let activityBridge: any = null;
const sessionIndex = new SessionIndex(PI_SESSIONS_ROOT);
const processManager = new ProcessManager();
const taskManager = new TaskManager(processManager);
const lspManager = new LspManager();
const hookManager = new HookManager();
const attentionManager = new AttentionManager();
const contracts = new Map<string, CompletionContract>();
let daemonClient: DaemonClient | null = null;
/** Authoritative runtime ownership. "daemon" only after a successful startup
 *  handshake; "local" when the daemon is disabled, missing, or unreachable at
 *  startup. This is intentionally NOT flipped by a transient disconnect — a
 *  daemon that blips and reconnects stays daemon-owned, it just can't be
 *  reached for a moment (`daemonConnected`). */
let runtimeOwner: "local" | "daemon" = "local";
/** Liveness of the daemon socket. Transient: drops on a blip, restored on
 *  reconnect. Never changes `runtimeOwner`. */
let daemonConnected = false;

function daemonPaths() {
  return {
    socketPath: join(app.getPath("userData"), "daemon.sock"),
    snapshotPath: join(app.getPath("userData"), "daemon-state.json"),
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
  if (runtimeOwner === "daemon" && daemonClient) return createDaemonRuntime(daemonClient);
  // Fallback to local runtime — host may be null during early startup, so guard
  const hostForLocal = host ?? ({ open: async () => ({}), prompt: async () => ({}), abort: async () => ({}), getState: async () => ({}), getMessages: async () => [] } as unknown as PiHost);
  return createLocalRuntime({ taskManager, attentionManager, hookManager, piHost: hostForLocal, contracts });
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
 *  back to local state — local does not own the runtime and mutating it would
 *  corrupt the daemon's authoritative view. */
function requireDaemonClient(): DaemonClient {
  if (runtimeOwner !== "daemon") throw new Error("not in daemon mode");
  const client = daemonOnly();
  if (!client) throw new Error("daemon is reconnecting — try again shortly");
  return client;
}

/** Install the LSP notifier that delivers diagnostics to the daemon-owned
 *  PiHost. Called both at startup (when the socket is live) and on reconnect
 *  (when the socket was down at startup but came back later). */
function installDaemonNotifier(client: DaemonClient): void {
  lspManager.setPiNotifier((diagCwd, diagnostics) => {
    if (diagCwd !== activeCwd) return;
    client.request("pi.notifyDiagnostics", { diagnostics }).catch(() => {});
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
 *  NOT equivalent to "there are no tasks" — the caller must surface the
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

// ---------------------------------------------------------------------------
// Workflows bridge (pi-dynamic-workflows run state)
// ---------------------------------------------------------------------------

/** (Re)create the workflows bridge when the session cwd changes. */
function applyCwd(cwd: string): void {
  if (!cwd) return;
  activeCwd = cwd;
  taskManager.resumeForSession(host?.activeSessionFile);
  // LSP: set active project; failures are best-effort (e.g. cwd deleted).
  void lspManager.setActiveProject(cwd).catch(() => undefined);
}

function updateActivityBridge(_cwd: string): void {
  // Threads/subagents activity lives inside PiHost's private ThreadManager /
  // ManagedSubagents. PiHost must expose them (or an activity snapshot) before
  // this bridge can be wired — follow-up to the OMP→PiHost swap.
}

function updateWorkflowsBridge(_cwd: string): void {
  // The pi-dynamic-workflows run-state bridge needs the same PiHost exposure.
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
    trafficLightPosition: { x: 20, y: 26 },
    backgroundColor: "#161616",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  win.webContents.session.setPermissionRequestHandler((_wc: any, permission: string, callback: any) => {
    if ((permission as string) === "local-fonts") callback(true);
    else callback(false);
  });
  // Some Chromium builds also gate local-fonts behind a check handler
  try {
    const ses: any = win.webContents.session;
    ses.setPermissionCheckHandler?.((wc: any, perm: string) => (perm as string) === "local-fonts" ? true : false);
  } catch {}
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, devUrl, RENDERER_ENTRY)) event.preventDefault();
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
    win.webContents.on("console-message", (event) => {
      const msg = (event as any).message ?? "";
      const level = (event as any).level ?? 1;
      const tag =
        level === 0 ? "debug" : level === 1 ? "log" : level === 2 ? "warn" : level === 3 ? "error" : "info";
      console.log(`[renderer:${tag}] ${msg}`);
    });
  }
}

function sendStatus(status: string, extra: Record<string, unknown> = {}): void {
  win?.webContents.send("pideck:session-status", { status, cwd: activeCwd, ...extra });
}

// ---------------------------------------------------------------------------
// git + session-file helpers (worktrees)
// ---------------------------------------------------------------------------

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

interface GitInfo {
  isRepo: boolean;
  root?: string;
  branch?: string;
  isLinkedWorktree?: boolean;
}

async function gitInfo(cwd: string): Promise<GitInfo> {
  try {
    const inside = await git(["rev-parse", "--is-inside-work-tree"], cwd);
    if (inside !== "true") return { isRepo: false };
    const [root, branch, gitDir] = await Promise.all([
      git(["rev-parse", "--show-toplevel"], cwd),
      git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).catch(() => "HEAD"),
      git(["rev-parse", "--git-dir"], cwd),
    ]);
    return {
      isRepo: true,
      root,
      branch,
      isLinkedWorktree: gitDir.replace(/\\/g, "/").includes(".git/worktrees/"),
    };
  } catch {
    return { isRepo: false };
  }
}

interface GitFileChange {
  path: string;
  status: string;
}

interface GitStatusResult {
  isRepo: boolean;
  root?: string;
  branch?: string;
  isWorktree?: boolean;
  dirty: GitFileChange[];
  ahead: number;
  behind: number;
}

/** Computes the full working-tree git status for a directory. */
async function gitStatus(cwd: string): Promise<GitStatusResult> {
  const base = await gitInfo(cwd);
  if (!base.isRepo) return { isRepo: false, dirty: [], ahead: 0, behind: 0 };
  const result: GitStatusResult = {
    isRepo: true,
    root: base.root,
    branch: base.branch,
    isWorktree: base.isLinkedWorktree,
    dirty: [],
    ahead: 0,
    behind: 0,
  };
  try {
    // List concrete untracked files while retaining Git's standard ignore,
    // info/exclude, and global-excludes behavior.
    const porcelain = await git(["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all"], cwd);
    result.dirty = porcelain
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
  } catch {
    /* not a repo or git unavailable */
  }
  try {
    const counts = await git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], cwd);
    const [behind, ahead] = counts.split("\t").map((n) => parseInt(n, 10) || 0);
    result.behind = behind;
    result.ahead = ahead;
  } catch {
    /* no upstream configured */
  }
  return result;
}

async function readSessionHeader(file: string): Promise<any> {
  try {
    const fd = await fsp.open(file, "r");
    try {
      const buf = Buffer.alloc(16 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      const firstLine = buf.toString("utf8", 0, bytesRead).split("\n")[0];
      return JSON.parse(firstLine);
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

/** Ensure a cloned session file exists on disk for task resume and header patching. */
async function ensureClonedSessionFile(
  clonedPath: string,
  originalPath: string,
  cwd: string,
  sessionId?: string
): Promise<void> {
  for (let i = 0; i < 15 && !existsSync(clonedPath); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (existsSync(clonedPath)) return;
  const raw = await fsp.readFile(originalPath, "utf8").catch(() => "");
  const nl = raw.indexOf("\n");
  const entries = nl === -1 ? "" : raw.slice(nl);
  const header = {
    type: "session",
    version: 3,
    id: sessionId ?? `forked-${Date.now()}`,
    timestamp: new Date().toISOString(),
    cwd,
    parentSession: originalPath,
  };
  await fsp.writeFile(clonedPath, `${JSON.stringify(header)}\n${entries}`);
}

/** Rewrite cloned-session ownership metadata while the agent is idle. */
async function rewriteSessionHeader(
  file: string,
  patch: { cwd?: string; parentSession?: string }
): Promise<void> {
  for (let i = 0; i < 15 && !existsSync(file); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const raw = await fsp.readFile(file, "utf8");
  const nl = raw.indexOf("\n");
  const header = JSON.parse(nl === -1 ? raw : raw.slice(0, nl));
  if (patch.cwd) header.cwd = patch.cwd;
  if (patch.parentSession) header.parentSession = patch.parentSession;
  await fsp.writeFile(file, JSON.stringify(header) + (nl === -1 ? "\n" : raw.slice(nl)));
}

function sanitizeWorktreeName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function uniquePath(base: string): string {
  let p = base;
  let i = 2;
  while (existsSync(p)) p = `${base}-${i++}`;
  return p;
}

function cwdWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root);
    return true;
  } catch {
    return false;
  }
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
      permission: permissionEngine
        ? {
            evaluate: (action) => permissionEngine!.evaluate(action),
            requestApproval,
            clearSessionRules: () => permissionEngine!.clearSessionRules(),
          }
        : undefined,
      hookManager,
      getTaskIdForSessionFile: (file) => taskManager.findBySessionFile(file)?.id,
      onEvent: (ev) => {
        agentEvents.push(ev);
        if (ev?.type === "message_end" || ev?.type === "agent_settled" || ev?.type === "session_info_changed") {
          sessionIndex.touch();
        }
      },
      onStatus: (s: any) => {
        if (s?.cwd) applyCwd(s.cwd);
        sendStatus(s.status, { state: s.state, sessionPath: s.sessionPath });
      },
    });
    await host.start();
    // Wire LSP -> Pi diagnostics delivery (bounded, newly introduced only).
    lspManager.setPiNotifier((diagCwd, diagnostics) => {
      if (diagCwd !== activeCwd) return;
      try {
        host!.notifyDiagnostics(diagnostics);
      } catch {}
    });
    applyCwd(activeCwd);
    // Warm but invisible — the user hasn't opened a session yet.
    console.log("[pideck] pi host ready (in-process)");
  } catch (err) {
    host = null;
    sendStatus("error", { message: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// IPC (pideck:* channels — same surface as before; renderer unchanged)
// ---------------------------------------------------------------------------

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? event.sender.getURL();
  const devOrigin = process.env.VITE_DEV_SERVER_URL;
  const trusted = isTrustedRendererUrl(url, devOrigin, RENDERER_ENTRY);
  if (!trusted || event.sender !== win?.webContents) throw new Error("untrusted IPC sender");
}

function registerIpc(): void {
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event);
      return listener(event, ...args);
    });
  };

  handle("pideck:list-sessions", () => sessionIndex.list());
  handle("pideck:get-session-messages", async (_e, path: string) => {
    const target = await validateSessionPath(PI_SESSIONS_ROOT, path);
    const window = await readSessionTail(target);
    return { ...window, messages: mergeRecaps(window.messages, await getRuntime().getRecaps(target) as any) };
  });

  handle("pideck:get-session-window", async (_e, path: string, endOffset: number, countBytes?: number) => {
    const target = await validateSessionPath(PI_SESSIONS_ROOT, path);
    if (!Number.isSafeInteger(endOffset) || endOffset < 0) throw new Error("invalid session window offset");
    const maxBytes = Math.min(Math.max(countBytes ?? 2 * 1024 * 1024, 256 * 1024), 16 * 1024 * 1024);
    const window = await readSessionRange(target, endOffset, maxBytes);
    return { ...window, messages: mergeRecapsIntoWindow(window.messages, await getRuntime().getRecaps(target) as any) };
  });

  handle("pideck:get-tool-output", async (_e, toolCallId: string) => {
    if (typeof toolCallId !== "string" || !/^[a-zA-Z0-9|_\-:.]{1,200}$/.test(toolCallId)) throw new Error("invalid tool call id");
    return getRuntime().getToolOutput(toolCallId);
  });

  handle("pideck:delete-session", async (_e, path: string) => {
    const target = await validateSessionPath(PI_SESSIONS_ROOT, path);
    const active = await getRuntime().getActiveSessionFile();
    if (active === target) {
      throw new Error("Close this chat before deleting it");
    }
    await fsp.rm(target, { force: true });
    sessionIndex.touch();
  });

  handle("pideck:pick-folder", async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: "Choose project folder",
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle(
    "pideck:open-session",
    async (_e, opts: { path?: string; cwd: string; requestId?: number }) => {
      if (!opts || typeof opts.cwd !== "string" || opts.cwd.length > 4096) throw new Error("invalid session options");
      if (hostReady) await hostReady;
      const path = opts.path === undefined ? undefined : await validateSessionPath(PI_SESSIONS_ROOT, opts.path);
      if (isDaemonOwned()) {
        const client = requireDaemonClient();
        const res = await client.request("pi.openSession", { ...opts, path });
        const state = res.payload as { sessionFile?: string };
        const t = await daemonTaskBySessionFile(state?.sessionFile ?? null);
        if (t?.status === "paused") await client.request("task.updated", { id: t.id, patch: { status: "running" } });
        return state;
      }
      const state = (await getRuntime().openSession({ ...opts, path })) as { sessionFile?: string } | null | undefined;
      taskManager.resumeForSession((state as { sessionFile?: string } | null | undefined)?.sessionFile);
      return state;
    }
  );

  handle("pideck:prompt", async (_e, message: string, images?: any[], streamingBehavior?: string) => {
    if (typeof message !== "string" || message.length > 2_000_000) throw new Error("invalid prompt payload");
    if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") {
      throw new Error("invalid streaming behavior");
    }
    if (images !== undefined) {
      if (!Array.isArray(images) || images.length > 20) throw new Error("invalid image payload");
      for (const image of images) {
        if (image?.type !== "image" || typeof image.data !== "string" || image.data.length > 15_000_000) {
          throw new Error("invalid image payload");
        }
        if (typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) {
          throw new Error("invalid image MIME type");
        }
      }
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.prompt", { message, images, streamingBehavior });
      return res.payload;
    }
    return getRuntime().prompt(message, images, streamingBehavior);
  });
  handle("pideck:abort", async () => {
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.abort", {});
      return res.payload;
    }
    return getRuntime().abort();
  });
  handle("pideck:refresh-session", async (_e, path: string) => {
    const p = await validateSessionPath(PI_SESSIONS_ROOT, path);
    // Route through the runtime facade so local and daemon modes behave the
    // same: the daemon returns { refreshed: boolean } via pi.refreshFromDisk,
    // not a raw pi.getState payload.
    return getRuntime().refreshFromDisk(p);
  });
  handle("pideck:get-messages", async () => {
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.getMessages", {});
      return res.payload;
    }
    return getRuntime().getMessages();
  });
  handle("pideck:get-state", async () => {
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.getState", {});
      return res.payload;
    }
    return getRuntime().getState();
  });
  handle("pideck:get-stats", async () => {
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.getStats", {});
      return res.payload;
    }
    return (getRuntime() as any).getStats?.() ?? (getHost() as any).getStats();
  });
  handle("pideck:git-status", async (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || cwd.length > 4096) throw new Error("invalid cwd");
    try {
      return await gitStatus(cwd);
    } catch {
      return { isRepo: false, dirty: [], ahead: 0, behind: 0 };
    }
  });
  // Git integration (status, commit/push/pull, branches, pull requests)
  const requireCwd = (cwd: unknown): string => {
    if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4096) throw new Error("invalid cwd");
    return cwd;
  };
  handle("pideck:git-status-details", async (_e, cwd: unknown) => {
    try {
      return await gitOps.statusDetails(requireCwd(cwd));
    } catch {
      return { isRepo: false };
    }
  });
  handle("pideck:git-branches", (_e, cwd: unknown) => gitOps.listBranches(requireCwd(cwd)));
  handle("pideck:git-diff-file", async (_e, cwd: unknown, file: unknown) => {
    const root = requireCwd(cwd);
    if (typeof file !== "string" || file.length === 0 || file.length > 1024 || file.includes("\u0000")) {
      throw new Error("invalid file path");
    }
    return gitOps.diffForFile(root, file);
  });
  handle("pideck:git-branch-create", (_e, cwd: unknown, name: unknown, switchTo: unknown) => {
    if (typeof name !== "string" || name.length > 200) throw new Error("invalid branch name");
    return gitOps.createBranch(requireCwd(cwd), name, switchTo === true);
  });
  handle("pideck:git-branch-switch", (_e, cwd: unknown, name: unknown, options: unknown) => {
    if (typeof name !== "string" || name.length > 200) throw new Error("invalid branch name");
    if (options !== undefined && (typeof options !== "object" || options === null || typeof (options as any).stash !== "boolean")) {
      throw new Error("invalid switch options");
    }
    return gitOps.switchBranch(requireCwd(cwd), name, options as { stash?: boolean } | undefined);
  });
  handle("pideck:git-commit-push", async (event, cwd: unknown, requestId: unknown) => {
    const root = requireCwd(cwd);
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 100) throw new Error("invalid request id");
    if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) throw new Error("invalid request id format");
    const emit = (phase: string, message: string) => {
      if (!event.sender.isDestroyed()) event.sender.send("pideck:git-commit-push-progress", { requestId, phase, message });
    };
    let committed = false;
    let stagedForRecovery = false;
    let prepared: import("./git").PreparedCommitContext | null = null;
    try {
      emit("preparing", "Staging changes and preparing diff context");
      prepared = await gitOps.prepareCommitContext(root);
      const context = prepared;
      stagedForRecovery = true;
      if (context.truncatedPatch) emit("generating", "Generating commit message (patch truncated — using file summary for remaining changes)");
      else emit("generating", "Generating commit message");
      const generated = await getRuntime().generateCommitMessage(context) as any;
      emit("committing", `Committing ${generated.subject}`);
      const commit = await gitOps.commitStaged(root, generated.message);
      committed = true;
      stagedForRecovery = false;
      emit("pushing", "Pushing current branch");
      const push = await gitOps.pushCurrentBranch(root);
      const pushLabel = push.status === "skipped_up_to_date" ? `Already up to date on ${push.branch}` : `Committed and pushed ${push.branch}`;
      emit("done", pushLabel);
      return { generated, commit, push };
    } catch (cause) {
      // If we staged via prepareCommitContext but failed before commit, restore
      // the user's pre-existing staged selection instead of leaving a
      // half-staged state.
      if (stagedForRecovery && !committed) {
        await gitOps.resetStaged(root, prepared ?? undefined);
        emit("error", `${cause instanceof Error ? cause.message : String(cause)} — staged changes were unstaged`);
      }
      const detail = cause instanceof Error ? cause.message : String(cause);
      const message = committed ? `Commit succeeded, but push failed: ${detail}` : detail;
      if (!stagedForRecovery || committed) emit("error", message);
      throw new Error(message);
    }
  });
  handle("pideck:git-commit", (_e, cwd: unknown, message: unknown) => {
    if (typeof message !== "string" || message.length > 20_000) throw new Error("invalid commit message");
    return gitOps.commitAll(requireCwd(cwd), message);
  });
  handle("pideck:git-push", (_e, cwd: unknown) => gitOps.pushCurrentBranch(requireCwd(cwd)));
  handle("pideck:git-pull", (_e, cwd: unknown) => gitOps.pullCurrentBranch(requireCwd(cwd)));
  handle("pideck:git-pr-context", (_e, cwd: unknown) => gitOps.prContext(requireCwd(cwd)));
  handle("pideck:git-pr-suggest", (_e, cwd: unknown) => gitOps.suggestPrContent(requireCwd(cwd)));
  handle("pideck:git-pr-create", (_e, cwd: unknown, input: unknown) => {
    const title = (input as any)?.title;
    const body = (input as any)?.body;
    if (typeof title !== "string" || title.length > 500) throw new Error("invalid PR title");
    if (body !== undefined && (typeof body !== "string" || body.length > 100_000)) throw new Error("invalid PR body");
    return gitOps.createPr(requireCwd(cwd), { title, body: typeof body === "string" ? body : "" });
  });
  handle("pideck:git-stage-file", (_e, cwd: unknown, file: unknown) => {
    if (typeof file !== "string" || !file.trim() || file.length > 4096) throw new Error("invalid file");
    return gitOps.stageFile(requireCwd(cwd), file);
  });
  handle("pideck:git-unstage-file", (_e, cwd: unknown, file: unknown) => {
    if (typeof file !== "string" || !file.trim() || file.length > 4096) throw new Error("invalid file");
    return gitOps.unstageFile(requireCwd(cwd), file);
  });
  handle("pideck:git-discard-file", (_e, cwd: unknown, file: unknown) => {
    if (typeof file !== "string" || !file.trim() || file.length > 4096) throw new Error("invalid file");
    return gitOps.discardFile(requireCwd(cwd), file);
  });
  handle("pideck:git-stage-hunk", (_e, cwd: unknown, file: unknown, patch: unknown) => {
    if (typeof file !== "string" || !file.trim() || file.length > 4096) throw new Error("invalid file");
    if (typeof patch !== "string" || !patch.trim() || patch.length > 200_000) throw new Error("invalid patch");
    return gitOps.stageHunk(requireCwd(cwd), file, patch);
  });
  handle("pideck:git-discard-hunk", (_e, cwd: unknown, file: unknown, patch: unknown) => {
    if (typeof file !== "string" || !file.trim() || file.length > 4096) throw new Error("invalid file");
    if (typeof patch !== "string" || !patch.trim() || patch.length > 200_000) throw new Error("invalid patch");
    return gitOps.discardHunk(requireCwd(cwd), file, patch);
  });

  handle("pideck:get-models", () => getRuntime().getModels());
  handle("pideck:get-commands", () => getRuntime().getCommands());
  handle("pideck:set-model", (_e, provider: string, modelId: string) =>
    getRuntime().setModel(provider, modelId)
  );
  handle("pideck:set-thinking", (_e, level: string) => getRuntime().setThinking(level));
  handle("pideck:get-thinking-levels", () => getRuntime().getThinkingLevels());
  handle("pideck:list-fonts", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const pexec = promisify((await import("node:child_process")).exec);
    const all = new Set<string>();
    all.add("System Default");
    // 1) Try font-list (may be inside asar, may fallback)
    try {
      const { getFonts } = await import("font-list");
      const fonts: string[] = await (getFonts as any)({ disableQuoting: true });
      for (const f of fonts) {
        const c = f.replace(/^[\"']|[\"']$/g, "").trim();
        if (c) all.add(c);
      }
    } catch {}
    // 2) system_profiler — most reliable on macOS, includes Miracode
    try {
      const { stdout } = await pexec(`system_profiler SPFontsDataType 2>/dev/null | grep "Family:" | awk -F: '{print $2}' | sort | uniq`, { maxBuffer: 10 * 1024 * 1024 }) as any;
      for (const line of String(stdout).split("\n")) {
        const c = line.trim();
        if (c) all.add(c);
      }
    } catch {}
    // 3) Direct font file scan — catches newly installed .ttf/.otf like Miracode.ttf
    try {
      const { readdirSync, existsSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      const { join, basename } = await import("node:path");
      for (const dir of [join(homedir(), "Library/Fonts"), "/Library/Fonts", "/System/Library/Fonts"]) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
          if (/\.(ttf|otf|ttc)$/i.test(f)) {
            const name = basename(f).replace(/\.(ttf|otf|ttc)$/i, "").replace(/[-_]/g, " ").trim();
            if (name) all.add(name);
            // Also add the raw family name without mangling for exact match
            const raw = basename(f).replace(/\.(ttf|otf|ttc)$/i, "");
            if (raw && raw !== name) all.add(raw);
          }
        }
      }
      // Ensure Miracode.ttf is explicitly added if present
      if (existsSync(join(homedir(), "Library/Fonts/Miracode.ttf"))) all.add("Miracode");
    } catch {}
    const cleaned = [...all].sort((a, b) => a.localeCompare(b));
    // Ensure System Default is first
    const sorted = ["System Default", ...cleaned.filter((f) => f !== "System Default")];
    return sorted;
  });
  handle("pideck:get-settings", () => getRuntime().getSettings());
  handle("pideck:set-settings", (_e, patch: any) => getRuntime().setSettings(patch));
  handle("pideck:set-session-name", (_e, name: string) => {
    if (typeof name !== "string" || name.length > 500) throw new Error("invalid session name");
    return getRuntime().setSessionName(name);
  });
  handle("pideck:compact", () => getRuntime().compact());

  // Branching / worktrees
  handle("pideck:get-tree", () => getRuntime().getTree());
  handle("pideck:get-history", () => getRuntime().getHistory());
  handle("pideck:turn-changes", (_e, entryId: unknown) => {
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    return getRuntime().getTurnChanges(entryId);
  });
  handle("pideck:turn-file-diff", (_e, entryId: unknown, path: unknown) => {
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    if (typeof path !== "string" || path.length < 1 || path.length > 4096) throw new Error("invalid file path");
    return getRuntime().getTurnFileDiff(entryId, path);
  });
  handle("pideck:rollback:prepare", (_e, entryId: string) => {
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    return getRuntime().prepareRollback(entryId);
  });
  handle("pideck:rollback:commit", (_e, planId: string) => {
    if (typeof planId !== "string" || !/^[0-9a-f-]{36}$/i.test(planId)) throw new Error("invalid rollback plan ID");
    return getRuntime().commitRollback(planId);
  });
  handle("pideck:rollback:undo", () => getRuntime().undoRollback());
  handle("pideck:get-fork-messages", () => getRuntime().getForkMessages());
  handle("pideck:fork", (_e, entryId: string) => {
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    return getRuntime().fork(entryId);
  });
  handle("pideck:clone", () => getRuntime().clone());
  handle("pideck:task-list", async () => getRuntime().taskList());
  handle("pideck:task-get", async (_e, id: unknown) => {
    if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new Error("invalid task id");
    return getRuntime().taskGet(id);
  });
  handle("pideck:task-set-contract", async (_e, taskId: unknown, contract: unknown) => {
    const id = validateId(taskId);
    if (!contract || typeof (contract as CompletionContract).id !== "string") throw new Error("invalid contract");
    const c = contract as CompletionContract;
    await getRuntime().contractSet(c);
    // Also set contractId on task via facade
    const task = await getRuntime().taskGet(id);
    if (task) await getRuntime().taskUpdate(id, { contractId: c.id } as never);
    return c;
  });
  handle("pideck:task-complete", async (_e, taskId: unknown, results: unknown) => {
    const id = validateId(taskId);
    const runtime = getRuntime();
    const task = await runtime.taskGet(id);
    if (!task) throw new Error("unknown task");
    const checkResults = Array.isArray(results) ? (results as CheckResult[]) : [];
    const hooks = await runtime.hooksList();
    const registry = { hooks: Object.fromEntries(hooks.map((h) => [h.id, h])), order: hooks.map((h) => h.id) } as import("../src/hooks").HookRegistry;
    const { dispatchHooks } = await import("../src/hook-dispatcher");
    const hookOutcome = await dispatchHooks(
      registry,
      "before_stop",
      { sessionId: task.sessionId ?? "", taskId: id },
      async (def) => {
        if (def.action === "block") return { block: { reason: `Blocked by hook ${def.id}` } };
        return {};
      }
    );
    if (hookOutcome.blocked) {
      await runtime.attentionRaise({
        id: `hook-${id}-${Date.now()}`,
        type: "blocked_task",
        title: `Task blocked by hook: ${task.title}`,
        detail: hookOutcome.blocked.result.block?.reason ?? "blocked",
        source: id,
        createdAt: Date.now(),
        resolved: false,
      });
      return { blocked: true, reason: hookOutcome.blocked.result.block?.reason, hookId: hookOutcome.blocked.id };
    }
    // The daemon owns the contract gate when enabled: it evaluates the
    // persisted contract and raises failed_task attention atomically, so the
    // gate survives client restarts. The local runtime mirrors that logic.
    const outcome = await runtime.taskComplete(id, checkResults);
    if (outcome.blocked && daemonOnly()) {
      // Surface the daemon-raised failed_task item on the attention channel
      // like any attention.raised event.
      daemonOnly()
        ?.request("state.get", {})
        .then((res) => {
          const runtimeState = (res.payload as { runtime?: { attention?: unknown } })?.runtime;
          win?.webContents.send("pideck:attention-update", runtimeState?.attention ?? { items: {} });
        })
        .catch(() => {});
    }
    return outcome;
  });
  handle("pideck:hooks-list", async () => getRuntime().hooksList());
  handle("pideck:hooks-register", async (_e, hook: unknown) => {
    if (!hook || typeof (hook as { id?: unknown }).id !== "string") throw new Error("invalid hook");
    await getRuntime().hooksRegister(hook as import("../src/hooks").HookDefinition);
    return getRuntime().hooksList();
  });
  handle("pideck:hooks-remove", async (_e, id: unknown) => {
    await getRuntime().hooksRemove(validateId(id));
    return getRuntime().hooksList();
  });
  handle("pideck:contracts-list", async () => getRuntime().contractsList());
  handle("pideck:contracts-get", async (_e, id: unknown) => getRuntime().contractGet(validateId(id as string)));
  handle("pideck:attention-list", async () => getRuntime().attentionList());
  handle("pideck:attention-resolve", async (_e, id: unknown) => {
    await getRuntime().attentionResolve(validateId(id));
    return getRuntime().attentionList();
  });

  handle("pideck:worktree-info", async () => {
    try {
      const state = await getRuntime().getState() as any;
      const file = state?.sessionFile;
      const header = file ? await readSessionHeader(file) : null;
      const task = isDaemonOwned()
        ? await daemonTaskBySessionFile(file)
        : taskManager.findBySessionFile(file);
      const parentSession = header?.parentSession ?? task?.parentSessionFile;
      const cwd = header?.cwd ?? task?.cwd ?? activeCwd;
      const g = cwd ? await gitInfo(cwd) : { isRepo: false };
      return {
        isWorktree: !!parentSession,
        sessionFile: file,
        parentSession,
        cwd,
        task,
        git: g,
      };
    } catch {
      return { isWorktree: false, git: { isRepo: false } };
    }
  });

  handle(
    "pideck:worktree-create",
    async (_e, opts: { name: string; description?: string; useGit?: boolean }) => {
      if (!opts || typeof opts.name !== "string" || opts.name.length > 200) throw new Error("invalid worktree name");
      if (opts.description !== undefined && (typeof opts.description !== "string" || opts.description.length > 20_000)) {
        throw new Error("invalid worktree description");
      }
      const before: any = await getRuntime().getState();
      if (!before?.sessionFile) {
        throw new Error("no persisted session to worktree yet — send at least one message first");
      }
      const originalPath = before.sessionFile;
      const originalCwd = activeCwd;
      let worktreePath: string | undefined;
      let gitWorktree: { path: string; branch: string; baseBranch?: string } | null = null;
      let gitRoot: string | undefined;

      try {
        const cloneRes: any = await getRuntime().clone();
        if (cloneRes?.cancelled) throw new Error("worktree cancelled by extension");
        worktreePath = (await getRuntime().getState() as any)?.sessionFile;
        if (!worktreePath || worktreePath === originalPath) throw new Error("clone did not produce a session file");

        const safeName = sanitizeWorktreeName(opts.name) || `exp-${Date.now().toString(36)}`;
        await getRuntime().setSessionName(`worktree: ${safeName}`);
        const afterNameState: any = await getRuntime().getState();
        await ensureClonedSessionFile(worktreePath, originalPath, activeCwd, afterNameState?.sessionId);
        let workCwd = activeCwd;

        if (opts.useGit) {
          const header = (await readSessionHeader(worktreePath)) ?? {};
          const baseCwd = header.cwd ?? activeCwd;
          const info = await gitInfo(baseCwd);
          if (!info.isRepo || !info.root) {
            throw new Error("project is not a git repository — uncheck the git worktree option");
          }
          gitRoot = info.root;
          let branch = `pideck/${safeName}`;
          for (let i = 2; await branchExists(info.root, branch); i++) branch = `pideck/${safeName}-${i}`;
          const wtPath = uniquePath(join(dirname(info.root), `${basename(info.root)}--${safeName}`));
          await git(["worktree", "add", "-b", branch, wtPath], info.root);
          gitWorktree = { path: wtPath, branch, baseBranch: info.branch };
          await rewriteSessionHeader(worktreePath, { cwd: wtPath });
          await getRuntime().switchTo(worktreePath as any);
          workCwd = wtPath;
          applyCwd(wtPath);
        }

        if (opts.description?.trim()) {
          await getRuntime()
            .prompt(
              `[Experimental worktree "${safeName}"${gitWorktree ? `, git branch ${gitWorktree.branch}` : ""}] ${opts.description.trim()}`
            )
            .catch(() => {});
        }

        const state: any = await getRuntime().getState();
        if (!state?.sessionId) throw new Error("cloned session has no runtime identity");
        let task: import("../src/tasks").Task;
        if (isDaemonOwned()) {
          const client = requireDaemonClient();
          const payload = {
            id: randomUUID(),
            title: safeName,
            status: "running" as const,
            ownerSession: before.sessionId,
            sessionId: state.sessionId,
            sessionFile: worktreePath,
            parentSessionFile: originalPath,
            cwd: workCwd,
            branch: gitWorktree?.branch,
            worktreePath: gitWorktree?.path,
            dirty: false,
            terminalIds: [],
            checkpointIds: [],
            createdAt: Date.now(),
          };
          const res = await client.request("task.created", payload);
          task = res.payload as import("../src/tasks").Task;
        } else {
          task = taskManager.register({
            title: safeName,
            ownerSession: before.sessionId,
            sessionId: state.sessionId,
            sessionFile: worktreePath,
            parentSessionFile: originalPath,
            cwd: workCwd,
            branch: gitWorktree?.branch,
            worktreePath: gitWorktree?.path,
          });
        }
        sendStatus("ready", { state, sessionPath: worktreePath, cwd: workCwd });
        return { task, taskId: task.id, worktreePath, originalPath, gitWorktree };
      } catch (error) {
        // Clone + git worktree creation is transactional: restore the original
        // runtime first, then remove only artifacts this attempt created.
        let restored = false;
        try {
          await getRuntime().switchTo(originalPath as any);
          restored = true;
          applyCwd(originalCwd);
        } catch {
          // Preserve the cloned session if restoration failed; deleting the
          // active file would make recovery harder.
        }
        if (gitWorktree && gitRoot) {
          await git(["worktree", "remove", "--force", gitWorktree.path], gitRoot).catch(() => {});
          await git(["branch", "-D", gitWorktree.branch], gitRoot).catch(() => {});
        }
        if (restored && worktreePath) await fsp.rm(worktreePath, { force: true }).catch(() => {});
        throw error;
      }
    }
  );

  handle("pideck:worktree-exit", async (_e, opts: { keep: boolean }) => {
    if (!opts || typeof opts.keep !== "boolean") throw new Error("invalid worktree exit options");
    const state: any = await getRuntime().getState();
    const file = state?.sessionFile;
    if (!file) throw new Error("no active session");
    const header = await readSessionHeader(file);
    const task = isDaemonOwned()
      ? await daemonTaskBySessionFileStrict(requireDaemonClient(), file)
      : taskManager.findBySessionFile(file);
    const originalPath = header?.parentSession ?? task?.parentSessionFile;
    if (!originalPath || !existsSync(originalPath)) {
      throw new Error("this session has no original to return to");
    }
    const workCwd = header?.cwd ?? task?.cwd;
    const gitWorktree = workCwd ? await gitInfo(workCwd) : { isRepo: false };
    const dirty = gitWorktree.isLinkedWorktree
      ? (await gitOps.statusDetails(workCwd)).hasChanges
      : false;

    const cleanup = async () => {
      await getRuntime().switchTo(originalPath as any);

      let gitRemoved = false;
      if (!opts.keep) {
        if (workCwd && gitWorktree.isLinkedWorktree) {
          const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], workCwd).catch(() => "");
          const commonDir = await git(["rev-parse", "--git-common-dir"], workCwd);
          const mainRoot = dirname(commonDir.startsWith("/") ? commonDir : join(workCwd, commonDir));
          await git(["worktree", "remove", "--force", workCwd], mainRoot);
          if (branch.startsWith("pideck/")) await git(["branch", "-D", branch], mainRoot).catch(() => {});
          gitRemoved = true;
        }
        await fsp.rm(file);
      }

      const newState: any = await getRuntime().getState();
      const origHeader = await readSessionHeader(originalPath);
      applyCwd(origHeader?.cwd ?? activeCwd);
      sendStatus("ready", { state: newState, sessionPath: originalPath, cwd: activeCwd });
      return { originalPath, kept: opts.keep, gitRemoved };
    };

    if (task) {
      if (isDaemonOwned()) {
        // The task lives in the daemon. A local `taskManager.exit` would
        // remove a task the daemon does not know we removed, and the
        // task.updated/task.removed calls below need a live socket.
        const client = requireDaemonClient();
        if (!opts.keep && dirty) throw new Error("Cannot discard a task worktree with uncommitted changes");
        await processManager.killByOwner(task.id).catch(() => {});
        const result = await cleanup();
        if (opts.keep) {
          await client.request("task.updated", { id: task.id, patch: { status: "paused", dirty } });
        } else {
          await client.request("task.removed", { id: task.id });
        }
        return { ...result, task, removed: !opts.keep };
      }
      return taskManager.exit({ taskId: task.id, keep: opts.keep, dirty, cleanup });
    }
    if (isDaemonOwned() && !daemonOnly()) {
      // No task resolved (daemon has none for this session, *or* the socket
      // is down and we could not tell which). Refuse rather than run cleanup
      // while the daemon still believes a task is running.
      throw new Error("daemon is reconnecting — try again shortly");
    }
    if (!opts.keep && dirty) throw new Error("Cannot discard a task worktree with uncommitted changes");
    return cleanup();
  });

  handle("pideck:ui-respond", (_e, resp: { id: string; [k: string]: unknown }) => {
    if (!resp || typeof resp.id !== "string" || resp.id.length > 200) throw new Error("invalid dialog response");
    return getRuntime().respondUi(resp.id, resp);
  });
  handle("pideck:open-external", async (_e, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("invalid external URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`blocked external URL protocol: ${parsed.protocol}`);
    }
    await shell.openExternal(parsed.toString());
  });

  // ---------------------------------------------------------------------------
  // Permission system (Phase 1): modes, rules, and approval resolution.
  // ---------------------------------------------------------------------------

  handle("pideck:permissions:get", async () => {
    if (isDaemonOwned()) {
      // The daemon is the authority for policy when it owns the runtime.
      // Return its current state directly. A disconnected daemon
      // surfaces as a thrown error (the UI shows a reconnecting
      // indicator) rather than a fabricated `auto` default that would
      // silently downgrade the agent's effective permissions.
      const client = requireDaemonClient();
      const res = await client.request("permissions.get", {});
      return res.payload;
    }
    if (!permissionEngine) return { mode: "auto" as const, rules: [] };
    return { mode: permissionEngine.getMode(), rules: permissionEngine.listRules() };
  });
  handle("pideck:permissions:set-mode", async (_e, mode: string) => {
    if (mode !== "supervised" && mode !== "auto" && mode !== "full_access") {
      throw new Error("invalid execution mode");
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("permissions.set-mode", { mode });
      return res.payload;
    }
    if (!permissionEngine) throw new Error("permission engine not ready");
    void permissionEngine.setModeAndPersist(mode as any);
    // A mode change retroactively re-evaluates what the agent is blocked on:
    // under Full Access the pending approvals are no longer required, so
    // release them instead of leaving the agent waiting on stale gates.
    if (mode === "full_access") {
      for (const [id, pending] of pendingApprovals) {
        clearTimeout(pending.timer);
        pendingApprovals.delete(id);
        win?.webContents.send("pideck:approval-cleared", { id });
        pending.resolve(true);
      }
    }
    notifyPermissionsChanged();
    return { mode: permissionEngine.getMode() };
  });
  handle("pideck:permissions:add-rule", async (_e, input: any) => {
    if (!input || typeof input.category !== "string" || (input.decision !== "allow" && input.decision !== "deny")) {
      throw new Error("invalid rule");
    }
    if (input.scope !== "always" && input.scope !== "session") {
      throw new Error("invalid rule scope");
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("permissions.add-rule", input);
      return res.payload;
    }
    if (!permissionEngine) throw new Error("permission engine not ready");
    const rule = permissionEngine.addRule({
      category: input.category,
      decision: input.decision,
      scope: input.scope,
      match: input.match,
      note: input.note,
    });
    notifyPermissionsChanged();
    return rule;
  });
  handle("pideck:permissions:remove-rule", async (_e, id: string) => {
    if (typeof id !== "string" || id.length < 1 || id.length > 200) throw new Error("invalid rule id");
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("permissions.remove-rule", { id });
      return res.payload;
    }
    if (!permissionEngine) throw new Error("permission engine not ready");
    const removed = permissionEngine.removeRule(id);
    notifyPermissionsChanged();
    return { removed };
  });
  handle("pideck:permissions:resolve-approval", async (_e, payload: { id: string; choice: string }) => {
    if (!payload || typeof payload.id !== "string" || typeof payload.choice !== "string") {
      throw new Error("invalid approval resolution");
    }
    if (isDaemonOwned()) {
      // Approvals are owned by the daemon in daemon mode. A local resolution
      // here would return { ok: true } while the daemon never hears about
      // the choice; the agent would then wait on a gate that no one will
      // ever open. Refuse loudly when the socket is down rather than lie.
      const client = requireDaemonClient();
      await client.request("approval.resolved", { id: payload.id, choice: payload.choice });
      win?.webContents.send("pideck:approval-resolved", { id: payload.id, choice: payload.choice });
      return { ok: true };
    }
    resolveApproval(payload.id, payload.choice as any);
    return { ok: true };
  });

  // Threads + subagents (project-local extension state)
  handle("pideck:activity:list", () =>
    activityBridge?.list() ?? Promise.resolve({ threads: [], subagents: [] })
  );
  handle(
    "pideck:threads:control",
    async (_e, opts: { action: "steer" | "follow-up" | "stop"; threadId: string; message?: string }) => {
      if (!/^[a-f0-9-]{8,}$/i.test(opts.threadId)) throw new Error("invalid thread id");
      if (opts.action !== "steer" && opts.action !== "follow-up" && opts.action !== "stop") {
        throw new Error("invalid thread action");
      }
      if (opts.action !== "stop" && !opts.message?.trim()) throw new Error("message is required");
      const result = await getRuntime().controlThread(opts.action, opts.threadId, opts.message?.trim());
      await activityBridge?.refresh();
      return result;
    }
  );
  handle("pideck:threads:promote", async (_e, threadId: string) => {
    if (!/^[a-f0-9-]{8,}$/i.test(threadId)) throw new Error("invalid thread id");
    const result = await getRuntime().promoteThread(threadId);
    await activityBridge?.refresh();
    return result;
  });
  handle(
    "pideck:subagents:control",
    async (_e, opts: { action: "steer" | "follow-up" | "stop"; runId: string; message?: string }) => {
      if (!/^[a-f0-9-]{20,}$/i.test(opts.runId)) throw new Error("invalid subagent run id");
      if (opts.action !== "steer" && opts.action !== "follow-up" && opts.action !== "stop") throw new Error("invalid subagent action");
      if (opts.action !== "stop" && !opts.message?.trim()) throw new Error("message is required");
      const result = await getRuntime().controlSubagent(opts.action, opts.runId, opts.message?.trim());
      await activityBridge?.refresh();
      return result;
    }
  );
  handle("pideck:subagents:promote", async (_e, runId: string) => {
    if (!/^[a-f0-9-]{20,}$/i.test(runId)) throw new Error("invalid subagent run id");
    const result = await getRuntime().promoteSubagent(runId);
    await activityBridge?.refresh();
    return result;
  });

  // Workflows (pi-dynamic-workflows run state)
  handle("pideck:workflows:list", () => workflowsBridge?.list() ?? Promise.resolve([]));
  handle("pideck:workflows:get", (_e, runId: string) =>
    workflowsBridge?.get(runId) ?? Promise.resolve(null)
  );
  handle("pideck:workflows:delete", (_e, runId: string) =>
    workflowsBridge?.delete(runId) ?? Promise.resolve(false)
  );
  handle(
    "pideck:workflows:control",
    (_e, opts: { action: string; runId: string }) => {
      if (!workflowsBridge) throw new Error("workflows bridge not ready");
      return workflowsBridge.control(opts.action, opts.runId);
    }
  );

  // LSP diagnostics loop
  handle("pideck:lsp-get-snapshot", (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || cwd.length > 4096) throw new Error("invalid cwd");
    const validated = validateLspCwd(cwd);
    return lspManager.getSnapshot(validated);
  });
  handle("pideck:lsp-list-snapshots", () => lspManager.listSnapshots());
  handle("pideck:lsp-set-project", (_e, cwd: unknown) => {
    if (cwd !== null && (typeof cwd !== "string" || cwd.length > 4096)) throw new Error("invalid cwd");
    if (cwd !== null && (cwd as string).includes("\0")) throw new Error("invalid cwd");
    if (cwd === null) return lspManager.setActiveProject(null);
    const validated = validateLspCwd(cwd as string);
    return lspManager.setActiveProject(validated);
  });
  handle("pideck:lsp-refresh", (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || cwd.length > 4096) throw new Error("invalid cwd");
    const validated = validateLspCwd(cwd);
    return lspManager.refresh(validated);
  });

  // Subscribe to LSP updates
  lspManager.subscribe((snapshots) => {
    win?.webContents.send("pideck:lsp-update", snapshots);
  });

  // Process manager (Electron-owned manual and task-owned project commands)
  handle("pideck:process-list", () => processManager.list());
  handle("pideck:process-spawn", async (_e, opts: unknown) => {
    const command = validateCommand((opts as { command?: unknown })?.command);
    const cwd = validateCwd((opts as { cwd?: unknown })?.cwd);
    if (isDaemonOwned()) {
      // Tasks live in the daemon when it owns the runtime. Resolving them
      // from the local TaskManager (which is empty in daemon mode) would
      // produce an ownerless process that the daemon knows nothing about.
      const client = requireDaemonClient();
      const activeFile = await daemonActiveSessionFileStrict(client);
      const activeTask = await daemonTaskBySessionFileStrict(client, activeFile);
      if (activeTask) {
        const proc = processManager.spawn({ command, cwd, owner: activeTask.id, ownerSession: activeTask.sessionId });
        await client.request("task.updated", { id: activeTask.id, patch: { terminalIds: [...(activeTask.terminalIds ?? []), proc.id] } }).catch(() => {});
        return proc;
      }
      // No daemon task to attach to. Spawn ownerless; the process itself is
      // local (Electron owns the processManager), and there is no daemon
      // state to mutate.
      const owner = typeof (opts as { owner?: unknown })?.owner === "string" ? (opts as { owner: string }).owner.slice(0, 500) : undefined;
      const ownerSession =
        typeof (opts as { ownerSession?: unknown })?.ownerSession === "string"
          ? (opts as { ownerSession: string }).ownerSession.slice(0, 500)
          : undefined;
      return processManager.spawn({ command, cwd, owner, ownerSession });
    }
    const activeFile = host?.activeSessionFile ?? null;
    const activeTask = taskManager.findBySessionFile(activeFile);
    if (activeTask) {
      return taskManager.spawn(activeTask.id, command, cwd);
    }
    const owner = typeof (opts as { owner?: unknown })?.owner === "string" ? (opts as { owner: string }).owner.slice(0, 500) : undefined;
    const ownerSession =
      typeof (opts as { ownerSession?: unknown })?.ownerSession === "string"
        ? (opts as { ownerSession: string }).ownerSession.slice(0, 500)
        : undefined;
    return processManager.spawn({ command, cwd, owner, ownerSession });
  });
  handle("pideck:task-spawn", async (_e, taskId: unknown, command: unknown, cwd: unknown) => {
    const id = validateId(taskId);
    const validatedCommand = validateCommand(command);
    const validatedCwd = validateCwd(cwd);
    if (isDaemonOwned()) {
      // Tasks are daemon-owned in daemon mode. Falling through to the local
      // TaskManager (empty in daemon mode) would report "unknown task" while
      // the daemon is the actual authority and might have just lost the
      // socket for a moment. Use the strict fetch: a connected daemon that
      // fails the request is not "no such task".
      const client = requireDaemonClient();
      const task = (await daemonClientTasksStrict(client)).find((t) => t.id === id);
      if (!task) throw new Error("unknown task");
      if (task.status !== "running") throw new Error("task is not running");
      if (!task.cwd || !cwdWithin(task.cwd, validatedCwd)) throw new Error("process cwd does not match task cwd");
      const proc = processManager.spawn({ command: validatedCommand, cwd: validatedCwd, owner: task.id, ownerSession: task.sessionId });
      await client.request("task.updated", { id: task.id, patch: { terminalIds: [...(task.terminalIds ?? []), proc.id] } }).catch(() => {});
      return proc;
    }
    return taskManager.spawn(id, validatedCommand, validatedCwd);
  });
  handle("pideck:process-kill", (_e, id: unknown) => {
    const validated = validateId(id);
    return processManager.kill(validated);
  });
}

// ---------------------------------------------------------------------------
// Babylon daemon (Phase 6)
// ---------------------------------------------------------------------------

/**
 * Spawn the standalone daemon when the user enabled it. The daemon outlives
 * the GUI: it is detached and never killed on quit, so background execution
 * keeps running after the window closes. A daemon that already answers on the
 * socket is reused rather than replaced.
 */
async function ensureDaemon(): Promise<boolean> {
  if (!isDaemonEnabled()) return false;
  const { socketPath, snapshotPath } = daemonPaths();
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
    setTimeout(() => {
      probe.destroy();
      resolve(false);
    }, 1_000);
  });
  const entry = join(__dirname, "..", "dist-daemon", "main.mjs");
  const entryExists = existsSync(entry);
  if (!alive) {
    if (!entryExists) {
      console.warn("daemon.enabled is set but dist-daemon/main.mjs is missing; run pnpm build:daemon — falling back to in-process host");
      return false;
    }
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        BABYLON_DAEMON_SOCKET: socketPath,
        BABYLON_DAEMON_SNAPSHOT: snapshotPath,
        BABYLON_DAEMON_PERMISSIONS_DIR: permissionDir(),
        BABYLON_SETTINGS_PATH: app.getPath("userData") + "/pideck-settings.json",
      },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
  if (!daemonClient) {
    daemonClient = connectDaemonClient({ listen: { socketPath }, reconnect: { initialDelayMs: 100, maxDelayMs: 5000 } });
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
        daemonClient
          ?.request("state.get", {})
          .then((res) => {
            const runtime = (res.payload as { runtime?: { tasks?: { tasks: Record<string, unknown> } } })?.runtime;
            const tasks = runtime?.tasks ? Object.values(runtime.tasks.tasks) : [];
            win?.webContents.send("pideck:task-update", tasks);
          })
          .catch(() => {});
      }
      if (envelope.type === "attention.raised" || envelope.type === "attention.resolved") {
        daemonClient
          ?.request("state.get", {})
          .then((res) => {
            const runtime = (res.payload as { runtime?: { attention?: unknown } })?.runtime;
            win?.webContents.send("pideck:attention-update", runtime?.attention ?? { items: {} });
          })
          .catch(() => {});
      }
      if (envelope.type === "pi.event") {
        win?.webContents.send("pideck:agent-events", [envelope.payload]);
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
    await daemonClient.request("ping", {}, 5_000);
  } catch {
    return false;
  }
  runtimeOwner = "daemon";
  daemonConnected = true;
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
  // ensureDaemon() awaits the initial ping handshake, so by the time it
  // returns, `runtimeOwner` is authoritative ("daemon" only when the daemon
  // round-tripped a ping; "local" on a missing binary, refused socket, or
  // timed-out ping). No split-brain: we choose local vs daemon ownership
  // here, once, and start exactly one host. A later transient disconnect
  // flips `daemonConnected` but never reverts `runtimeOwner`.
  await ensureDaemon();
  if (isDaemonOwned()) {
    // Daemon owns tasks and attention when active — thin client, no local subscriptions
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
    // local notifier — there is no local host to receive diagnostics — and
    // instead install a notifier on reconnect (handled by the
    // onConnectionChange hook below).
    const notifierClient = daemonOnly();
    if (notifierClient) installDaemonNotifier(notifierClient);
    else installDeferredDaemonNotifier();
  } else {
    lspManager.setPiNotifier((diagCwd, diagnostics) => {
      if (diagCwd !== activeCwd) return;
      try {
        host!.notifyDiagnostics(diagnostics);
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
    activityBridge?.dispose();
    workflowsBridge?.dispose();
    void host?.dispose();
    app.quit();
  }
});

app.on("before-quit", () => {
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
  activityBridge?.dispose();
  workflowsBridge?.dispose();
  void host?.dispose();
});
