import type { IpcMainInvokeEvent } from "electron";
import type { RuntimeFacade } from "../src/runtime-facade";
import type { ActivityRegistry } from "./activity";

interface WorkflowsBridgeLike {
  list(): Promise<unknown>;
  get(runId: string): Promise<unknown>;
  delete(runId: string): Promise<unknown>;
  control(action: string, runId: string): unknown;
}

type Handle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
) => void;

export function registerActivityIpc(
  handle: Handle,
  deps: {
    getRuntime: () => RuntimeFacade;
    getActivityRegistry: () => ActivityRegistry | null;
    getWorkflowsBridge: () => WorkflowsBridgeLike | null;
  },
): void {
  const { getRuntime, getActivityRegistry, getWorkflowsBridge } = deps;
  // Threads + subagents (project-local extension state)
  handle("pideck:activity:list", () =>
    getActivityRegistry()?.listAll() ?? Promise.resolve({ threads: [], subagents: [] })
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
      await getActivityRegistry()?.refreshAll();
      return result;
    }
  );
  handle("pideck:threads:promote", async (_e, threadId: string) => {
    if (!/^[a-f0-9-]{8,}$/i.test(threadId)) throw new Error("invalid thread id");
    const result = await getRuntime().promoteThread(threadId);
    await getActivityRegistry()?.refreshAll();
    return result;
  });
  handle(
    "pideck:subagents:control",
    async (_e, opts: { action: "steer" | "follow-up" | "stop"; runId: string; message?: string }) => {
      if (!/^[a-f0-9-]{20,}$/i.test(opts.runId)) throw new Error("invalid subagent run id");
      if (opts.action !== "steer" && opts.action !== "follow-up" && opts.action !== "stop") throw new Error("invalid subagent action");
      if (opts.action !== "stop" && !opts.message?.trim()) throw new Error("message is required");
      const result = await getRuntime().controlSubagent(opts.action, opts.runId, opts.message?.trim());
      await getActivityRegistry()?.refreshAll();
      return result;
    }
  );
  handle("pideck:subagents:promote", async (_e, runId: string) => {
    if (!/^[a-f0-9-]{20,}$/i.test(runId)) throw new Error("invalid subagent run id");
    const result = await getRuntime().promoteSubagent(runId);
    await getActivityRegistry()?.refreshAll();
    return result;
  });

  // Workflows (pi-dynamic-workflows run state)
  handle("pideck:workflows:list", () => getWorkflowsBridge()?.list() ?? Promise.resolve([]));
  handle("pideck:workflows:get", (_e, runId: string) =>
    getWorkflowsBridge()?.get(runId) ?? Promise.resolve(null)
  );
  handle("pideck:workflows:delete", (_e, runId: string) =>
    getWorkflowsBridge()?.delete(runId) ?? Promise.resolve(false)
  );
  handle(
    "pideck:workflows:control",
    (_e, opts: { action: string; runId: string }) => {
      const bridge = getWorkflowsBridge();
      if (!bridge) throw new Error("workflows bridge not ready");
      return bridge.control(opts.action, opts.runId);
    }
  );
}
