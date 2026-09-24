import type { AttentionManager } from "./attention-manager";
import type { HookManager } from "./hook-manager";
import type { PiHost } from "./pi-host";
import type { TaskManager } from "./task-manager";
import type { CompletionContract } from "../src/completion-contracts";
import type { DaemonClient } from "../src/daemon-client";
import { createDaemonRuntime } from "../src/daemon-runtime";
import { createLocalRuntime } from "../src/local-runtime";
import type { RuntimeFacade } from "../src/runtime-facade";
import type { LocalPiHost } from "../src/local-pi-host";

export interface RuntimeDeps {
  runtimeOwner: "daemon" | "local";
  daemonClient: DaemonClient | null;
  host: PiHost | null;
  taskManager: TaskManager;
  attentionManager: AttentionManager;
  hookManager: HookManager;
  contracts: Map<string, CompletionContract>;
}

/**
 * Fail-fast member for the unstarted host below. (...args: never[]) =>
 * never is assignable to every function type, so the checker enforces
 * that the stub stays total: a PiHost member missing here is a build
 * error, never a runtime TypeError.
 */
function notReady(name: string): (...args: never[]) => never {
  return (..._args: never[]): never => {
    throw new Error(`pi host not started (called ${name} during early startup)`);
  };
}

/**
 * Stand-in host for the window between IPC registration and startHost()
 * completing. Five members preserve the historical early-startup contract
 * (session-restore reads resolve empty instead of rejecting); every other
 * member throws a named error. Total by construction — LocalPiHost has no
 * optional members, so drift is a compile error on both sides.
 */
function unstartedHost(): LocalPiHost {
  const fallback = {
    open: async () => ({}),
    prompt: async (): Promise<void> => {},
    abort: async (): Promise<void> => {},
    getState: async () => ({}),
    getMessages: async (): Promise<unknown[]> => [],
  };
  return {
    get activeSessionFile(): null {
      return null;
    },
    generateGitCommitMessage: notReady("generateGitCommitMessage"),
    getRecaps: notReady("getRecaps"),
    warmProject: notReady("warmProject"),
    ...fallback,
    refreshFromDisk: notReady("refreshFromDisk"),
    switchTo: notReady("switchTo"),
    relocateExecution: notReady("relocateExecution"),
    compact: notReady("compact"),
    getToolOutput: notReady("getToolOutput"),
    getStats: notReady("getStats"),
    getCommands: notReady("getCommands"),
    getModels: notReady("getModels"),
    setModel: notReady("setModel"),
    setThinking: notReady("setThinking"),
    getThinkingLevels: notReady("getThinkingLevels"),
    getSettings: notReady("getSettings"),
    setSettings: notReady("setSettings"),
    setSessionName: notReady("setSessionName"),
    renameSession: notReady("renameSession"),
    beginGoalPrompt: notReady("beginGoalPrompt"),    getHistory: notReady("getHistory"),
    getTurnChanges: notReady("getTurnChanges"),
    getTurnFileDiff: notReady("getTurnFileDiff"),
    prepareRollback: notReady("prepareRollback"),
    commitRollback: notReady("commitRollback"),
    undoRollback: notReady("undoRollback"),
    getTree: notReady("getTree"),
    getForkMessages: notReady("getForkMessages"),
    fork: notReady("fork"),
    clone: notReady("clone"),
    controlThread: notReady("controlThread"),
    promoteThread: notReady("promoteThread"),
    controlSubagent: notReady("controlSubagent"),
    promoteSubagent: notReady("promoteSubagent"),
    releaseSession: notReady("releaseSession"),
    respondUi: notReady("respondUi"),
    execGoalCommand: notReady("execGoalCommand"),
    listProjectExecutions: notReady("listProjectExecutions"),
    executionSnapshot: notReady("executionSnapshot"),
    activateExecution: notReady("activateExecution"),
    deactivateExecution: notReady("deactivateExecution"),
    execDesignCommand: notReady("execDesignCommand"),
    beginDesignPrompt: notReady("beginDesignPrompt"),
  };
}

/** Select the authoritative runtime. Daemon-owned mode never falls back to a
 *  local runtime: without a live client there is no host either (a local host
 *  would shadow the daemon after reconnect and split task/attention state),
 *  so fail fast instead of returning a facade whose pi calls throw TypeError. */
export function resolveRuntime(deps: RuntimeDeps): RuntimeFacade {
  const { runtimeOwner, daemonClient, host, taskManager, attentionManager, hookManager, contracts } = deps;
  if (runtimeOwner === "daemon") {
    if (!daemonClient) throw new Error("daemon is reconnecting, try again shortly");
    return createDaemonRuntime(daemonClient);
  }
  // Fallback to local runtime, host may be null during early startup, so guard
  const hostForLocal = host ?? unstartedHost();
  return createLocalRuntime({ taskManager, attentionManager, hookManager, piHost: hostForLocal, contracts });
}
