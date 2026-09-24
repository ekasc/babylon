import { shell, type IpcMainInvokeEvent } from "electron";
import type { IpcHandle } from "./ipc-handle";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fsp } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as gitOps from "./git";
import { branchExists, git, gitInfo } from "./git-status";
import { ensureClonedSessionFile, readSessionHeader, rewriteSessionHeader, sanitizeWorktreeName, uniquePath } from "./session-files";
import { wireOf, wireStr } from "../src/store";
import type { RuntimeFacade } from "../src/runtime-facade";
import type { DaemonClient } from "../src/daemon-client";
import type { Task } from "../src/tasks";
import type { TaskManager } from "./task-manager";
import type { ProcessManager } from "./process-manager";

type Handle = IpcHandle;

/** Build the owner-project resolver worktree mutations use.
 *
 * Identity comes from the runtime's execution registry — local host or daemon —
 * and NEVER from UI focus. A resolver failure is a failure, not an invitation to
 * substitute whichever project the user happens to be looking at (C3).
 */
export function createOwnerCwdResolver(
  getRuntime: () => RuntimeFacade
): (sessionFile: string) => Promise<string | null> {
  return async (sessionFile: string) => {
    try {
      return await getRuntime().executionCwdFor(sessionFile);
    } catch {
      return null;
    }
  };
}

export function registerWorktreeIpc(
  handle: Handle,
  deps: {
    getRuntime: () => RuntimeFacade;
    /** Resolve the project that OWNS an addressed session file. Execution
     *  mutations are identified by ownership, never by UI focus. */
    ownerCwdFor: (sessionFile: string) => Promise<string | null>;
    isDaemonOwned: () => boolean;
    daemonOnly: () => DaemonClient | null;
    requireDaemonClient: () => DaemonClient;
    daemonTaskBySessionFile: (file: string | null | undefined) => Promise<Task | undefined>;
    daemonTaskBySessionFileStrict: (client: DaemonClient, file: string | null | undefined) => Promise<Task | undefined>;
    taskManager: TaskManager;
    processManager: ProcessManager;
    getFocusedCwd: () => string;
  },
): void {
  const {
    getRuntime,
    ownerCwdFor,
    isDaemonOwned,
    daemonOnly,
    requireDaemonClient,
    daemonTaskBySessionFile,
    daemonTaskBySessionFileStrict,
    taskManager,
    processManager,
    getFocusedCwd,
  } = deps;
  handle("pideck:worktree-info", async (_e, sessionFile: unknown) => {
    if (typeof sessionFile !== "string" || sessionFile.length < 1 || sessionFile.length > 4096) {
      throw new Error("worktree-info requires a session file");
    }
    try {
      const state = await getRuntime().getState(sessionFile);
      const file = state?.sessionFile ?? null;
      const header = file ? await readSessionHeader(file) : null;
      const task = isDaemonOwned()
        ? await daemonTaskBySessionFile(file)
        : taskManager.findBySessionFile(file);
      const parentSession = wireStr(header ?? undefined, "parentSession") ?? task?.parentSessionFile;
      const cwd =
        wireStr(header ?? undefined, "cwd") ??
        task?.cwd ??
        (file ? await ownerCwdFor(file) : null) ??
        getFocusedCwd();
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
    async (_e, opts: { name: string; description?: string; useGit?: boolean }, sessionFile: unknown) => {
      if (typeof sessionFile !== "string" || sessionFile.length < 1 || sessionFile.length > 4096) {
        throw new Error("worktree-create requires a session file");
      }
      if (!opts || typeof opts.name !== "string" || opts.name.length > 200) throw new Error("invalid worktree name");
      if (opts.description !== undefined && (typeof opts.description !== "string" || opts.description.length > 20_000)) {
        throw new Error("invalid worktree description");
      }
      const before = await getRuntime().getState(sessionFile);
      if (!before?.sessionFile) {
        throw new Error("no persisted session to worktree yet, send at least one message first");
      }
      const originalPath = before.sessionFile;
      // The mutation's identity is the ADDRESSED session: its owning project
      // comes from execution ownership, so a UI focus change mid-operation
      // can never retarget the clone/relocation (C3/C7).
      const originalCwd = await ownerCwdFor(originalPath);
      if (!originalCwd) {
        throw new Error("that session is not this host's execution session — return to the live session first");
      }
      let gitWorktree: { path: string; branch: string; baseBranch?: string } | null = null;
      let gitRoot: string | undefined;

      let worktreePath: string | undefined;
      try {
        const cloneRes = await getRuntime().clone(before.sessionFile);
        if (cloneRes?.cancelled) throw new Error("worktree cancelled by extension");
        worktreePath = cloneRes?.sessionFile;
        if (!worktreePath || worktreePath === originalPath) throw new Error("clone did not produce a session file");

        const safeName = sanitizeWorktreeName(opts.name) || `exp-${Date.now().toString(36)}`;
        await getRuntime().setSessionName(worktreePath, `worktree: ${safeName}`);
        const afterNameState = await getRuntime().getState(worktreePath);
        await ensureClonedSessionFile(worktreePath, originalPath, originalCwd, afterNameState?.sessionId);
        let workCwd = originalCwd;

        if (opts.useGit) {
          const header = (await readSessionHeader(worktreePath)) ?? {};
          const baseCwd = wireStr(header ?? undefined, "cwd") ?? originalCwd;
          const info = await gitInfo(baseCwd);
          if (!info.isRepo || !info.root) {
            throw new Error("project is not a git repository, uncheck the git worktree option");
          }
          gitRoot = info.root;
          let branch = `pideck/${safeName}`;
          for (let i = 2; await branchExists(info.root, branch); i++) branch = `pideck/${safeName}-${i}`;
          const wtPath = uniquePath(join(dirname(info.root), `${basename(info.root)}--${safeName}`));
          await git(["worktree", "add", "-b", branch, wtPath], info.root);
          gitWorktree = { path: wtPath, branch, baseBranch: info.branch };
          await rewriteSessionHeader(worktreePath, { cwd: wtPath });
          if (!worktreePath) throw new Error("clone did not produce a session file");
          // The clone already owns this project; moving it into a git
          // worktree RELOCATES that ownership: the runtime is rebuilt under
          // the worktree cwd (services, permissions, tool contexts are
          // cwd-bound) instead of being re-pointed in place.
          await getRuntime().relocateExecution(worktreePath, originalCwd, wtPath);
          workCwd = wtPath;
        }

        if (opts.description?.trim()) {
          await getRuntime()
            .prompt(
              `[Experimental worktree "${safeName}"${gitWorktree ? `, git branch ${gitWorktree.branch}` : ""}] ${opts.description.trim()}`,
              undefined,
              undefined,
              worktreePath
            )
            .catch(() => {});
        }

        const state = await getRuntime().getState(worktreePath);
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
        // Explicit navigation identity: the renderer views exactly this
        // session. The backend never selects anything for it (items 138-141).
        return { task, taskId: task.id, worktreePath, originalPath, gitWorktree, sessionFile: worktreePath, cwd: workCwd };
      } catch (error) {
        // Clone + git worktree creation is transactional: restore the original
        // runtime first, then remove only artifacts this attempt created.
        let restored = false;
        try {
          // Restore ownership of the ORIGINAL session (the inverse move),
          // never via a hidden runtime-creating switch.
          await getRuntime().executionActivate(originalCwd, originalPath);
          restored = true;
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

  handle("pideck:worktree-exit", async (_e, opts: { keep: boolean }, sessionFile: unknown) => {
    if (!opts || typeof opts.keep !== "boolean") throw new Error("invalid worktree exit options");
    if (typeof sessionFile !== "string" || sessionFile.length < 1 || sessionFile.length > 4096) {
      throw new Error("worktree-exit requires a session file");
    }
    const state = await getRuntime().getState(sessionFile);
    const file = state?.sessionFile;
    if (!file) throw new Error("no active session");
    const header = await readSessionHeader(file);
    const task = isDaemonOwned()
      ? await daemonTaskBySessionFileStrict(requireDaemonClient(), file)
      : taskManager.findBySessionFile(file);
    const originalPath = wireStr(header ?? undefined, "parentSession") ?? task?.parentSessionFile;
    if (!originalPath || !existsSync(originalPath)) {
      throw new Error("this session has no original to return to");
    }
    const workCwd = wireStr(header ?? undefined, "cwd") ?? task?.cwd;
    const gitWorktree = workCwd ? await gitInfo(workCwd) : { isRepo: false };
    const dirty = gitWorktree.isLinkedWorktree && workCwd
      ? (await gitOps.statusDetails(workCwd)).hasChanges
      : false;

    const cleanup = async () => {
      // Leaving the worktree is an execution hand-back: the original session
      // becomes the project's owner again (its runtime is rebuilt under the
      // original cwd, never by changing what the UI shows).
      const originalHeader = await readSessionHeader(originalPath);
      const originalCwd =
        wireStr(originalHeader ?? undefined, "cwd") ??
        task?.cwd ??
        (await ownerCwdFor(originalPath));
      if (!originalCwd) {
        throw new Error("cannot resolve the original chat's project — return to the live session first");
      }
      await getRuntime().executionActivate(originalCwd, originalPath);

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

      // The renderer views the returned session explicitly; nothing here
      // navigates or reports readiness (items 140-141).
      return { originalPath, kept: opts.keep, gitRemoved, sessionFile: originalPath, cwd: originalCwd };
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
      throw new Error("daemon is reconnecting, try again shortly");
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
}
