import { dialog, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { IpcHandle } from "./ipc-handle";
import { promises as fsp } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { readSessionRange, readSessionTail, type SessionIndex } from "./sessions";
import { mergeRecaps, mergeRecapsIntoWindow, type Recap } from "./recap";
import { wireOf, wireStr } from "../src/store";
import { validateSessionPath } from "./session-path";
import { isSessionNotFound } from "../src/lib/errors";
import { buildBotSystemPrompt } from "../src/bots";
import type { BotStore } from "./bots";
import type { TaskManager } from "./task-manager";
import type { RuntimeFacade } from "../src/runtime-facade";
import type { DaemonClient } from "../src/daemon-client";
import type { Task } from "../src/tasks";
import type { PiHost } from "./pi-host";

type Handle = IpcHandle;

export function registerSessionsIpc(
  handle: Handle,
  deps: {
    sessionsRoot: string;
    sessionIndex: SessionIndex;
    getRuntime: () => RuntimeFacade;
    getHost: () => PiHost;
    isDaemonOwned: () => boolean;
    requireDaemonClient: () => DaemonClient;
    daemonTaskBySessionFile: (file: string | null | undefined) => Promise<Task | undefined>;
    getWindow: () => BrowserWindow | null;
    getHostReady: () => Promise<void> | null;
    botStore: BotStore;
    overlayForSessionFile: (file: string | null | undefined, cwd?: string) => string | null;
    taskManager: TaskManager;
  },
): void {
  const {
    sessionsRoot,
    sessionIndex,
    getRuntime,
    getHost,
    isDaemonOwned,
    requireDaemonClient,
    daemonTaskBySessionFile,
    getWindow,
    getHostReady,
    botStore,
    overlayForSessionFile,
    taskManager,
  } = deps;

  /** Recaps for a session file, validated: the runtime boundary hands back
   *  unknown (daemon socket or host), and only well-formed recaps merge. */
  const loadRecaps = async (target: string): Promise<Recap[]> => {
    const recaps = await getRuntime().getRecaps(target);
    if (!Array.isArray(recaps)) return [];
    return recaps.filter((r): r is Recap => {
      const w = wireOf(r);
      return !!w && typeof w.id === "string" && typeof w.at === "string" && typeof w.text === "string" &&
        (w.coveredEntryId === null || typeof w.coveredEntryId === "string");
    });
  };
  handle("pideck:list-sessions", () => sessionIndex.list());
  handle("pideck:get-session-messages", async (_e, path: string) => {
    const target = await validateSessionPath(sessionsRoot, path);
    const window = await readSessionTail(target);
    return { ...window, messages: mergeRecaps(window.messages, await loadRecaps(target)) };
  });

  handle("pideck:get-session-window", async (_e, path: string, endOffset: number, countBytes?: number) => {
    const target = await validateSessionPath(sessionsRoot, path);
    if (!Number.isSafeInteger(endOffset) || endOffset < 0) throw new Error("invalid session window offset");
    const maxBytes = Math.min(Math.max(countBytes ?? 2 * 1024 * 1024, 256 * 1024), 16 * 1024 * 1024);
    const window = await readSessionRange(target, endOffset, maxBytes);
    return { ...window, messages: mergeRecapsIntoWindow(window.messages, await loadRecaps(target)) };
  });

  handle("pideck:get-tool-output", async (_e, toolCallId: string) => {
    if (typeof toolCallId !== "string" || !/^[a-zA-Z0-9|_\-:.]{1,200}$/.test(toolCallId)) throw new Error("invalid tool call id");
    return getRuntime().getToolOutput(toolCallId);
  });

  handle("pideck:delete-session", async (_e, path: string) => {
    const target = await validateSessionPath(sessionsRoot, path);
    const active = await getRuntime().getActiveSessionFile();
    if (active === target) {
      throw new Error("Close this chat before deleting it");
    }
    await fsp.rm(target, { force: true });
    sessionIndex.touch();
    // Drop any retained runtime for the deleted file so it can never emit
    // into a replacement session (stale-runtime resurrection).
    if (!isDaemonOwned()) {
      try {
        await getHost().releaseSession(target);
      } catch {
        /* best effort; a live runtime refuses and the file is already gone */
      }
    }
  });

  handle("pideck:pick-folder", async () => {
    const r = await dialog.showOpenDialog(getWindow()!, {
      title: "Choose project folder",
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle(
    "pideck:open-session",
    async (_e, opts: { path?: string; cwd: string; requestId?: number; botId?: string }) => {
      if (!opts || typeof opts.cwd !== "string" || opts.cwd.length > 4096) throw new Error("invalid session options");
      if (getHostReady()) await getHostReady();
      let path: string | undefined;
      if (opts.path !== undefined) {
        try {
          path = await validateSessionPath(sessionsRoot, opts.path);
        } catch (err) {
          // A brand-new session (e.g. a bot's first chat) has a canonical
          // future path before its first flush, so it isn't on disk yet. If
          // the live host already owns exactly that file, resolve it
          // lexically (still containment-checked) and let PiHost sync from
          // the in-memory session instead of rejecting a session we own.
          const missing =
            isSessionNotFound(err) &&
            typeof opts.path === "string" && opts.path.endsWith(".jsonl");
          const lexical = missing ? resolve(opts.path) : null;
          const rel = lexical ? relative(resolve(sessionsRoot), lexical) : "";
          const inside = !!lexical && rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
          let owned: string | null = null;
          try {
            owned = getHost().activeSessionFile;
          } catch {}
          if (inside && lexical && owned && resolve(owned) === lexical) {
            path = lexical;
          } else {
            throw err;
          }
        }
      }
      if (isDaemonOwned()) {
        const client = requireDaemonClient();
        const res = await client.request("pi.openSession", { ...opts, path });
        const state = res.payload as { sessionFile?: string };
        const t = await daemonTaskBySessionFile(state?.sessionFile ?? null);
        if (t?.status === "paused") await client.request("task.updated", { id: t.id, patch: { status: "running" } });
        return state;
      }
      // Bot Mode: opening with a botId installs that bot's persona overlay for
      // the new runtime; opening a bot's canonical chat file does the same via
      // lookup so every entry point (sidebar rows, history, prefetch) agrees.
      // Any other file in a project gets the project default (rule 3); files
      // with no project context resolve null so prompts never leak across bots.
      // Passed as an immutable creation argument (never a host global), so
      // concurrent opens each build with exactly their own prompt.
      let systemPrompt: string | null = null;
      if (opts.botId !== undefined) {
        const bot = botStore.get(opts.botId);
        if (!bot) throw new Error("Bot not found");
        systemPrompt = buildBotSystemPrompt(bot, botStore.list());
      } else if (path !== undefined) {
        systemPrompt = overlayForSessionFile(path, opts.cwd);
      }
      const state = (await getRuntime().openSession({ ...opts, path, systemPrompt })) as { sessionFile?: string } | null | undefined;
      taskManager.resumeForSession((state as { sessionFile?: string } | null | undefined)?.sessionFile);
      return state;
    }
  );
}
