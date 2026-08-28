import { app, BrowserWindow, dialog, ipcMain, screen, shell, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import * as net from "node:net";
import { existsSync, promises as fsp, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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

/** Rewrite a session file's header cwd while the agent is idle. */
async function rewriteSessionCwd(file: string, cwd: string): Promise<void> {
  // clone() may defer flushing until the first assistant message; wait briefly.
  for (let i = 0; i < 15 && !existsSync(file); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const raw = await fsp.readFile(file, "utf8");
  const nl = raw.indexOf("\n");
  const header = JSON.parse(nl === -1 ? raw : raw.slice(0, nl));
  header.cwd = cwd;
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
    host = new PiHost({
      cwd,
      permission: permissionEngine
        ? {
            evaluate: (action) => permissionEngine!.evaluate(action),
            requestApproval,
            clearSessionRules: () => permissionEngine!.clearSessionRules(),
          }
        : undefined,
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
    return { ...window, messages: mergeRecaps(window.messages, await getHost().getRecaps(target)) };
  });

  handle("pideck:get-session-window", async (_e, path: string, endOffset: number, countBytes?: number) => {
    const target = await validateSessionPath(PI_SESSIONS_ROOT, path);
    if (!Number.isSafeInteger(endOffset) || endOffset < 0) throw new Error("invalid session window offset");
    const maxBytes = Math.min(Math.max(countBytes ?? 2 * 1024 * 1024, 256 * 1024), 16 * 1024 * 1024);
    const window = await readSessionRange(target, endOffset, maxBytes);
    return { ...window, messages: mergeRecapsIntoWindow(window.messages, await getHost().getRecaps(target)) };
  });

  handle("pideck:get-tool-output", async (_e, toolCallId: string) => {
    if (typeof toolCallId !== "string" || !/^[a-zA-Z0-9|_\-:.]{1,200}$/.test(toolCallId)) throw new Error("invalid tool call id");
    return getHost().getToolOutput(toolCallId);
  });

  handle("pideck:delete-session", async (_e, path: string) => {
    const target = await validateSessionPath(PI_SESSIONS_ROOT, path);
    if (getHost().activeSessionFile === target) {
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
      return getHost().open({ ...opts, path });
    }
  );

  handle("pideck:prompt", (_e, message: string, images?: any[], streamingBehavior?: string) => {
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
    return getHost().prompt(message, images, streamingBehavior as any);
  });
  handle("pideck:abort", () => getHost().abort());
  handle("pideck:refresh-session", async (_e, path: string) =>
    getHost().refreshFromDisk(await validateSessionPath(PI_SESSIONS_ROOT, path))
  );
  handle("pideck:get-messages", () => getHost().getMessages());
  handle("pideck:get-state", () => getHost().getState());
  handle("pideck:get-stats", () => getHost().getStats());
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
  handle("pideck:git-start-commit-push", async (_e, cwd: unknown) => {
    const root = requireCwd(cwd);
    const details = await gitOps.statusDetails(root);
    if (!details.isRepo) throw new Error("not a git repository");
    if (!details.hasChanges) throw new Error("no changes to commit");
    const result = await getHost().startGitCommitPush(root);
    await activityBridge?.refresh();
    return result;
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

  handle("pideck:get-models", () => getHost().getModels());
  handle("pideck:get-commands", () => getHost().getCommands());
  handle("pideck:set-model", (_e, provider: string, modelId: string) =>
    getHost().setModel(provider, modelId)
  );
  handle("pideck:set-thinking", (_e, level: string) => getHost().setThinking(level));
  handle("pideck:get-thinking-levels", () => getHost().getThinkingLevels());
  handle("pideck:get-settings", () => getHost().getSettings());
  handle("pideck:set-settings", (_e, patch: any) => getHost().setSettings(patch));
  handle("pideck:set-session-name", (_e, name: string) => {
    if (typeof name !== "string" || name.length > 500) throw new Error("invalid session name");
    return getHost().setSessionName(name);
  });
  handle("pideck:compact", () => getHost().compact());

  // Branching / worktrees
  handle("pideck:get-tree", () => getHost().getTree());
  handle("pideck:get-history", () => getHost().getHistory());
  handle("pideck:turn-changes", (_e, entryId: unknown) => {
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    return getHost().getTurnChanges(entryId);
  });
  handle("pideck:turn-file-diff", (_e, entryId: unknown, path: unknown) => {
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    if (typeof path !== "string" || path.length < 1 || path.length > 4096) throw new Error("invalid file path");
    return getHost().getTurnFileDiff(entryId, path);
  });
  handle("pideck:rollback:prepare", (_e, entryId: string) => {
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    return getHost().prepareRollback(entryId);
  });
  handle("pideck:rollback:commit", (_e, planId: string) => {
    if (typeof planId !== "string" || !/^[0-9a-f-]{36}$/i.test(planId)) throw new Error("invalid rollback plan ID");
    return getHost().commitRollback(planId);
  });
  handle("pideck:rollback:undo", () => getHost().undoRollback());
  handle("pideck:get-fork-messages", () => getHost().getForkMessages());
  handle("pideck:fork", (_e, entryId: string) => {
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    return getHost().fork(entryId);
  });
  handle("pideck:clone", () => getHost().clone());

  handle("pideck:worktree-info", async () => {
    try {
      const state = await getHost().getState();
      const file = state?.sessionFile;
      const header = file ? await readSessionHeader(file) : null;
      const cwd = header?.cwd ?? activeCwd;
      const g = cwd ? await gitInfo(cwd) : { isRepo: false };
      return {
        isWorktree: !!header?.parentSession,
        sessionFile: file,
        parentSession: header?.parentSession,
        cwd,
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
      const before = await getHost().getState();
      if (!before?.sessionFile) {
        throw new Error("no persisted session to worktree yet — send at least one message first");
      }
      const originalPath = before.sessionFile;
      const originalCwd = activeCwd;
      let worktreePath: string | undefined;
      let gitWorktree: { path: string; branch: string; baseBranch?: string } | null = null;
      let gitRoot: string | undefined;

      try {
        const cloneRes = await getHost().clone();
        if (cloneRes?.cancelled) throw new Error("worktree cancelled by extension");
        worktreePath = (await getHost().getState())?.sessionFile;
        if (!worktreePath || worktreePath === originalPath) throw new Error("clone did not produce a session file");

        const safeName = sanitizeWorktreeName(opts.name) || `exp-${Date.now().toString(36)}`;
        await getHost().setSessionName(`worktree: ${safeName}`).catch(() => {});
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
          await rewriteSessionCwd(worktreePath, wtPath);
          await getHost().switchTo(worktreePath);
          workCwd = wtPath;
          applyCwd(wtPath);
        }

        if (opts.description?.trim()) {
          await getHost()
            .prompt(
              `[Experimental worktree "${safeName}"${gitWorktree ? `, git branch ${gitWorktree.branch}` : ""}] ${opts.description.trim()}`
            )
            .catch(() => {});
        }

        const state = await getHost().getState();
        sendStatus("ready", { state, sessionPath: worktreePath, cwd: workCwd });
        return { worktreePath, originalPath, gitWorktree };
      } catch (error) {
        // Clone + git worktree creation is transactional: restore the original
        // runtime first, then remove only artifacts this attempt created.
        let restored = false;
        try {
          await getHost().switchTo(originalPath);
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
    const state = await getHost().getState();
    const file = state?.sessionFile;
    if (!file) throw new Error("no active session");
    const header = await readSessionHeader(file);
    const originalPath = header?.parentSession;
    if (!originalPath || !existsSync(originalPath)) {
      throw new Error("this session has no original to return to");
    }
    const workCwd = header?.cwd;

    await getHost().switchTo(originalPath);

    let gitRemoved = false;
    if (!opts.keep) {
      if (workCwd) {
        const g = await gitInfo(workCwd);
        if (g.isLinkedWorktree) {
          try {
            const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], workCwd).catch(() => "");
            const commonDir = await git(["rev-parse", "--git-common-dir"], workCwd);
            const mainRoot = dirname(commonDir.startsWith("/") ? commonDir : join(workCwd, commonDir));
            await git(["worktree", "remove", "--force", workCwd], mainRoot);
            if (branch.startsWith("pideck/")) {
              await git(["branch", "-D", branch], mainRoot).catch(() => {});
            }
            gitRemoved = true;
          } catch {
            /* leave on disk; user can clean up manually */
          }
        }
      }
      await fsp.rm(file).catch(() => {});
    }

    const newState = await getHost().getState();
    const origHeader = await readSessionHeader(originalPath);
    applyCwd(origHeader?.cwd ?? activeCwd);
    sendStatus("ready", { state: newState, sessionPath: originalPath, cwd: activeCwd });
    return { originalPath, kept: opts.keep, gitRemoved };
  });

  handle("pideck:ui-respond", (_e, resp: { id: string; [k: string]: unknown }) => {
    if (!resp || typeof resp.id !== "string" || resp.id.length > 200) throw new Error("invalid dialog response");
    getHost().respondUi(resp.id, resp);
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

  handle("pideck:permissions:get", () => {
    if (!permissionEngine) return { mode: "auto" as const, rules: [] };
    return { mode: permissionEngine.getMode(), rules: permissionEngine.listRules() };
  });
  handle("pideck:permissions:set-mode", (_e, mode: string) => {
    if (!permissionEngine) throw new Error("permission engine not ready");
    if (mode !== "supervised" && mode !== "auto" && mode !== "full_access") {
      throw new Error("invalid execution mode");
    }
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
  handle("pideck:permissions:add-rule", (_e, input: any) => {
    if (!permissionEngine) throw new Error("permission engine not ready");
    if (!input || typeof input.category !== "string" || (input.decision !== "allow" && input.decision !== "deny")) {
      throw new Error("invalid rule");
    }
    if (input.scope !== "always" && input.scope !== "session") {
      throw new Error("invalid rule scope");
    }
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
  handle("pideck:permissions:remove-rule", (_e, id: string) => {
    if (!permissionEngine) throw new Error("permission engine not ready");
    if (typeof id !== "string" || id.length < 1 || id.length > 200) throw new Error("invalid rule id");
    const removed = permissionEngine.removeRule(id);
    notifyPermissionsChanged();
    return { removed };
  });
  handle("pideck:permissions:resolve-approval", (_e, payload: { id: string; choice: string }) => {
    if (!payload || typeof payload.id !== "string" || typeof payload.choice !== "string") {
      throw new Error("invalid approval resolution");
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
      const result = await getHost().controlThread(opts.action, opts.threadId, opts.message?.trim());
      await activityBridge?.refresh();
      return result;
    }
  );
  handle("pideck:threads:promote", async (_e, threadId: string) => {
    if (!/^[a-f0-9-]{8,}$/i.test(threadId)) throw new Error("invalid thread id");
    const result = await getHost().promoteThread(threadId);
    await activityBridge?.refresh();
    return result;
  });
  handle(
    "pideck:subagents:control",
    async (_e, opts: { action: "steer" | "follow-up" | "stop"; runId: string; message?: string }) => {
      if (!/^[a-f0-9-]{20,}$/i.test(opts.runId)) throw new Error("invalid subagent run id");
      if (opts.action !== "steer" && opts.action !== "follow-up" && opts.action !== "stop") throw new Error("invalid subagent action");
      if (opts.action !== "stop" && !opts.message?.trim()) throw new Error("message is required");
      const result = await getHost().controlSubagent(opts.action, opts.runId, opts.message?.trim());
      await activityBridge?.refresh();
      return result;
    }
  );
  handle("pideck:subagents:promote", async (_e, runId: string) => {
    if (!/^[a-f0-9-]{20,}$/i.test(runId)) throw new Error("invalid subagent run id");
    const result = await getHost().promoteSubagent(runId);
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

  // Process manager (Electron-owned manual project commands)
  handle("pideck:process-list", () => processManager.list());
  handle("pideck:process-spawn", (_e, opts: unknown) => {
    const command = validateCommand((opts as { command?: unknown })?.command);
    const cwd = validateCwd((opts as { cwd?: unknown })?.cwd);
    const owner = typeof (opts as { owner?: unknown })?.owner === "string" ? (opts as { owner: string }).owner.slice(0, 500) : undefined;
    const ownerSession =
      typeof (opts as { ownerSession?: unknown })?.ownerSession === "string"
        ? (opts as { ownerSession: string }).ownerSession.slice(0, 500)
        : undefined;
    return processManager.spawn({ command, cwd, owner, ownerSession });
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
async function ensureDaemon(): Promise<void> {
  if (!getSettings().daemon?.enabled) return;
  const socketPath = join(app.getPath("userData"), "daemon.sock");
  const snapshotPath = join(app.getPath("userData"), "daemon-state.json");
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (alive) return;
  const entry = join(__dirname, "..", "dist-daemon", "main.mjs");
  if (!existsSync(entry)) {
    console.warn("daemon.enabled is set but dist-daemon/main.mjs is missing; run pnpm build:daemon");
    return;
  }
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      BABYLON_DAEMON_SOCKET: socketPath,
      BABYLON_DAEMON_SNAPSHOT: snapshotPath,
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  processManager.subscribe((snapshots) => win?.webContents.send("pideck:process-update", snapshots));
  sessionIndex.subscribe((update) => win?.webContents.send("pideck:sessions-update", update));
  // Start the in-process pi host immediately (builds shared services once) so
  // the first session open is instant. Runs in the background; the user just
  // sees sessions open with no "starting" phase.
  hostReady = startHost();
  void ensureDaemon();
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
  processManager.dispose();
  sessionIndex.dispose();
  activityBridge?.dispose();
  workflowsBridge?.dispose();
  void host?.dispose();
});
