import type { AttentionManager } from "./attention-manager";
import type { HookManager } from "./hook-manager";
import type { PiHost } from "./pi-host";
import type { TaskManager } from "./task-manager";
import type { CompletionContract } from "../src/completion-contracts";
import type { DaemonClient } from "../src/daemon-client";
import { createDaemonRuntime } from "../src/daemon-runtime";
import { createLocalRuntime } from "../src/local-runtime";
import type { RuntimeFacade } from "../src/runtime-facade";

export interface RuntimeDeps {
  runtimeOwner: "daemon" | "local";
  daemonClient: DaemonClient | null;
  host: PiHost | null;
  taskManager: TaskManager;
  attentionManager: AttentionManager;
  hookManager: HookManager;
  contracts: Map<string, CompletionContract>;
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
  const hostForLocal =
    host ??
    ({
      open: async () => ({}),
      prompt: async () => ({}),
      abort: async () => ({}),
      getState: async () => ({}),
      getMessages: async () => [],
    } as unknown as PiHost);
  return createLocalRuntime({ taskManager, attentionManager, hookManager, piHost: hostForLocal, contracts });
}
