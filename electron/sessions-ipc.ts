import { dialog, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { IpcHandle } from "./ipc-handle";
import { promises as fsp } from "node:fs";
import { resolve } from "node:path";
import { readSessionRange, readSessionTail, type SessionIndex } from "./sessions";
import { mergeRecaps, mergeRecapsIntoWindow, type Recap } from "./recap";
import { wireOf, wireStr } from "../src/store";
import { validateSessionPath } from "./session-path";
import type { RuntimeFacade } from "../src/runtime-facade";

type Handle = IpcHandle;

export function registerSessionsIpc(
  handle: Handle,
  deps: {
    sessionsRoot: string;
    sessionIndex: SessionIndex;
    getRuntime: () => RuntimeFacade;
    getWindow: () => BrowserWindow | null;
  },
): void {
  const { sessionsRoot, sessionIndex, getRuntime, getWindow } = deps;

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

  handle("pideck:rename-session", async (_e, opts: { path: string; name: string }) => {
    if (!opts || typeof opts.path !== "string" || opts.path.length < 1 || opts.path.length > 4096) {
      throw new Error("invalid session path");
    }
    if (typeof opts.name !== "string" || opts.name.length < 1 || opts.name.length > 500) {
      throw new Error("invalid session name");
    }
    // Path-addressed: works for the execution owner and for never-opened
    // sessions alike — no need to open the chat first. PiHost resolves and
    // validates; the index touch republishes the list with the new name.
    const result = await getRuntime().renameSession(opts.path, opts.name);
    sessionIndex.touch();
    return result;
  });
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

  handle("pideck:get-tool-output", async (_e, sessionFile: unknown, toolCallId: string) => {
    if (typeof sessionFile !== "string" || sessionFile.length < 1 || sessionFile.length > 4096) throw new Error("invalid session file");
    if (typeof toolCallId !== "string" || !/^[a-zA-Z0-9|_\-:.]{1,200}$/.test(toolCallId)) throw new Error("invalid tool call id");
    return getRuntime().getToolOutput(sessionFile, toolCallId);
  });

  handle("pideck:delete-session", async (_e, path: string) => {
    const target = await validateSessionPath(sessionsRoot, path);
    const executions = await getRuntime().executionList();
    if (executions.some((execution) => execution.sessionFile === target)) {
      throw new Error("Close this chat before deleting it");
    }
    await fsp.rm(target, { force: true });
    sessionIndex.touch();
    // No runtime cleanup is needed or possible: only a project's execution
    // owner is installed, and an owned file was refused above.
  });

  handle("pideck:pick-folder", async () => {
    const r = await dialog.showOpenDialog(getWindow()!, {
      title: "Choose project folder",
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : r.filePaths[0];
  });
}
