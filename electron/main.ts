import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { execFile } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ActivityBridge, type ActivityUpdate } from "./activity";
import { AgentEventBuffer } from "./event-buffer";
import { PiHost } from "./pi-host";
import { mergeRecaps } from "./recap";
import { SessionIndex, readSessionRange, readSessionTail, readToolOutput } from "./sessions";
import { resolveParentSessionFile } from "./threads";
import { WorkflowsBridge, type WorkflowControlAction, type WorkflowsUpdate } from "./workflows";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let host: PiHost | null = null;
let hostReady: Promise<void> | null = null;
let activeCwd = "";
let workflowsBridge: WorkflowsBridge | null = null;
let activityBridge: ActivityBridge | null = null;
const sessionIndex = new SessionIndex();
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
  updateWorkflowsBridge(cwd);
  updateActivityBridge(cwd);
}

function updateActivityBridge(cwd: string): void {
  if (!cwd || activityBridge?.cwd === cwd) return;
  activityBridge?.dispose();
  activityBridge = new ActivityBridge({
    cwd,
    onUpdate: (update: ActivityUpdate) => win?.webContents.send("pideck:activity-update", update),
    resolveParentSessionFile: (sessionId) => resolveParentSessionFile(sessionId),
    onThreadEvent: (thread, event) => getHost().notifyThreadEvent(thread, event),
  });
  activityBridge.start();
}

function updateWorkflowsBridge(cwd: string): void {
  if (!cwd) return;
  if (workflowsBridge?.cwd === cwd) return;
  workflowsBridge?.dispose();
  const nextBridge = new WorkflowsBridge({
    cwd,
    runCommand: async (command: string) => {
      // Extension commands execute synchronously via session.prompt("/…") — no
      // chat-history pollution, no LLM call; the extension's own error/notify
      // feedback arrives through the normal agent-event pipeline.
      await getHost().session.prompt(command);
    },
    getSessionId: async () => {
      try {
        const state = await getHost().getState();
        return state?.sessionId ?? null;
      } catch {
        return null;
      }
    },
    onUpdate: (runs) => {
      if (workflowsBridge !== nextBridge) return;
      const payload: WorkflowsUpdate = { runs };
      win?.webContents.send("pideck:workflows-update", payload);
    },
  });
  workflowsBridge = nextBridge;
  nextBridge.start();
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
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    show: !headless,
    title: "Babylon",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
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
    const allowed = devUrl ? url.startsWith("http://127.0.0.1:5173/") : url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });

  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "../dist/index.html"));
  }
  win.on("closed", () => {
    win = null;
  });
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
    host = new PiHost({
      cwd,
      stateDir: join(app.getPath("userData"), "rollback-state"),
      onEvent: (ev) => {
        agentEvents.push(ev);
        activityBridge?.observeAgentEvent(ev);
        if (ev?.type === "message_end" || ev?.type === "agent_settled" || ev?.type === "session_info_changed") {
          sessionIndex.touch();
        }
      },
      onStatus: (s) => {
        // The session cwd is the source of truth for the workflows bridge —
        // re-create it whenever the host reports a new cwd.
        if (s.cwd) applyCwd(s.cwd);
        sendStatus(s.status, { state: s.state, sessionPath: s.sessionPath });
      },
      onProjectTrust: async (cwd: string) => {
        const result = await dialog.showMessageBox(win!, {
          type: "warning",
          title: "Trust project resources?",
          message: `Trust project folder?\n\n${cwd}`,
          detail:
            "Trusting allows this project to load its .pi settings, extensions, skills, prompts, packages, and system instructions.",
          buttons: ["Trust once", "Trust & remember", "Don't trust"],
          defaultId: 0,
          cancelId: 2,
        });
        return { trusted: result.response !== 2, remember: result.response === 1 };
      },
      onMissingCwd: async (sessionFile: string, storedCwd: string) => {
        // The session's project folder no longer exists. Ask where it should
        // run now, mirroring pi's interactive-mode prompt.
        const r = await dialog.showMessageBox(win!, {
          type: "warning",
          title: "Session folder is gone",
          message: `This session's folder no longer exists:\n\n${storedCwd}`,
          detail: `Continue this session in a new location? The session history stays intact.`,
          buttons: ["Choose new folder…", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
        if (r.response !== 0) return null;
        const pick = await dialog.showOpenDialog(win!, {
          title: "Choose where this session should run",
          properties: ["openDirectory", "createDirectory"],
        });
        return pick.canceled ? null : pick.filePaths[0];
      },
    });
    await host.start();
    applyCwd(activeCwd);
    // Warm but invisible — the user hasn't opened a session yet.
    console.log("[pideck] pi host ready in-process (shared services loaded once)");
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
  const trusted = devOrigin ? url.startsWith(`${new URL(devOrigin).origin}/`) : url.startsWith("file://");
  if (!trusted || event.sender !== win?.webContents) throw new Error("untrusted IPC sender");
}

/** Resolves a session path and enforces it stays inside the pi sessions dir. */
function validateSessionPath(path: string): string {
  const root = resolve(homedir(), ".pi", "agent", "sessions");
  const target = resolve(path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !target.endsWith(".jsonl")) {
    throw new Error("session path is outside the pi sessions directory");
  }
  return target;
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
    const target = validateSessionPath(path);
    const window = await readSessionTail(target);
    return { ...window, messages: mergeRecaps(window.messages, await getHost().getRecaps(target)) };
  });

  handle("pideck:get-session-window", async (_e, path: string, endOffset: number, countBytes?: number) => {
    const target = validateSessionPath(path);
    const maxBytes = Math.min(Math.max(countBytes ?? 2 * 1024 * 1024, 256 * 1024), 16 * 1024 * 1024);
    const window = await readSessionRange(target, endOffset, maxBytes);
    return { ...window, messages: mergeRecaps(window.messages, await getHost().getRecaps(target)) };
  });

  handle("pideck:get-tool-output", async (_e, toolCallId: string) => {
    if (typeof toolCallId !== "string" || !/^[a-zA-Z0-9|_\-:.]{1,200}$/.test(toolCallId)) throw new Error("invalid tool call id");
    return getHost().getToolOutput(toolCallId);
  });

  handle("pideck:delete-session", async (_e, path: string) => {
    const target = validateSessionPath(path);
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
      if (hostReady) await hostReady;
      return getHost().open(opts);
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
  handle("pideck:refresh-session", (_e, path: string) => getHost().refreshFromDisk(path));
  handle("pideck:get-messages", () => getHost().getMessages());
  handle("pideck:get-state", () => getHost().getState());
  handle("pideck:get-stats", () => getHost().getStats());
  handle("pideck:get-models", () => getHost().getModels());
  handle("pideck:get-commands", () => getHost().getCommands());
  handle("pideck:set-model", (_e, provider: string, modelId: string) =>
    getHost().setModel(provider, modelId)
  );
  handle("pideck:set-thinking", (_e, level: string) => getHost().setThinking(level));
  handle("pideck:get-thinking-levels", () => getHost().getThinkingLevels());
  handle("pideck:set-session-name", (_e, name: string) => {
    if (typeof name !== "string" || name.length > 500) throw new Error("invalid session name");
    return getHost().setSessionName(name);
  });
  handle("pideck:compact", () => getHost().compact());

  // Branching / worktrees
  handle("pideck:get-tree", () => getHost().getTree());
  handle("pideck:get-history", () => getHost().getHistory());
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
    (_e, opts: { action: WorkflowControlAction; runId: string }) => {
      if (!workflowsBridge) throw new Error("workflows bridge not ready");
      return workflowsBridge.control(opts.action, opts.runId);
    }
  );
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  sessionIndex.subscribe((update) => win?.webContents.send("pideck:sessions-update", update));
  // Start the in-process pi host immediately (builds shared services once) so
  // the first session open is instant. Runs in the background; the user just
  // sees sessions open with no "starting" phase.
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
    sessionIndex.dispose();
    activityBridge?.dispose();
    workflowsBridge?.dispose();
    void host?.dispose();
    app.quit();
  }
});

app.on("before-quit", () => {
  agentEvents.dispose();
  sessionIndex.dispose();
  activityBridge?.dispose();
  workflowsBridge?.dispose();
  void host?.dispose();
});
