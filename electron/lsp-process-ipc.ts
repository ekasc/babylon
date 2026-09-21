import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { IpcHandle } from "./ipc-handle";
import { validateCommand, validateCwd, validateId, type ProcessManager } from "./process-manager";
import { validateCwd as validateLspCwd, type LspManager } from "./lsp-manager";
import type { TaskManager } from "./task-manager";
import type { DaemonClient } from "../src/daemon-client";
import type { Task } from "../src/tasks";
import type { PiHost } from "./pi-host";
import { cwdWithin } from "./session-files";

type Handle = IpcHandle;

export function registerLspProcessIpc(
  handle: Handle,
  deps: {
    lspManager: LspManager;
    processManager: ProcessManager;
    taskManager: TaskManager;
    getHost: () => PiHost | null;
    isDaemonOwned: () => boolean;
    requireDaemonClient: () => DaemonClient;
    daemonActiveSessionFileStrict: (client: DaemonClient) => Promise<string | null>;
    daemonTaskBySessionFileStrict: (client: DaemonClient, file: string | null | undefined) => Promise<Task | undefined>;
    daemonClientTasksStrict: (client: DaemonClient) => Promise<Task[]>;
    getWindow: () => BrowserWindow | null;
  },
): void {
  const {
    lspManager,
    processManager,
    taskManager,
    getHost,
    isDaemonOwned,
    requireDaemonClient,
    daemonActiveSessionFileStrict,
    daemonTaskBySessionFileStrict,
    daemonClientTasksStrict,
    getWindow,
  } = deps;
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
    getWindow()?.webContents.send("pideck:lsp-update", snapshots);
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
    const activeFile = getHost()?.activeSessionFile ?? null;
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
