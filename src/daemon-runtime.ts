import type { RuntimeFacade } from "./runtime-facade";
import type { Task } from "./tasks";
import type { CompletionContract } from "./completion-contracts";
import type { HookDefinition } from "./hooks";
import type { AttentionRegistry, AttentionItem } from "./attention";
import { connectDaemonClient, type DaemonClient } from "./daemon-client";

export function createDaemonRuntime(client: DaemonClient): RuntimeFacade {
  return {
    async taskList() {
      const res = await client.request("state.get", {});
      const runtime = (res.payload as { runtime?: { tasks?: { tasks: Record<string, Task> } } })?.runtime;
      return runtime?.tasks ? Object.values(runtime.tasks.tasks) : [];
    },
    async taskGet(id) {
      const res = await client.request("state.get", {});
      const runtime = (res.payload as { runtime?: { tasks?: { tasks: Record<string, Task> } } })?.runtime;
      return runtime?.tasks?.tasks[id] ?? null;
    },
    async taskCreate(task) {
      const res = await client.request("task.created", task);
      return res.payload as Task;
    },
    async taskUpdate(id, patch) {
      const res = await client.request("task.updated", { id, patch });
      return res.payload as Task;
    },
    async taskRemove(id) {
      const res = await client.request("task.removed", { id });
      return (res.payload as { removed: boolean }).removed;
    },
    async contractGet(id) {
      const res = await client.request("contract.get", { id });
      return (res.payload as { contract: CompletionContract | null }).contract ?? null;
    },
    async contractSet(c) {
      await client.request("contract.registered", c);
    },
    async contractsList() {
      const res = await client.request("contract.list", {});
      return (res.payload as { contracts: CompletionContract[] }).contracts ?? [];
    },
    async taskComplete(id, results) {
      const res = await client.request("task.complete", { id, results });
      return res.payload as { blocked: boolean; reason?: string; evaluation?: import("./completion-contracts").ContractEvaluation };
    },
    async hooksList() {
      const res = await client.request("state.get", {});
      const runtime = (res.payload as { runtime?: { hooks?: { hooks: Record<string, HookDefinition> } } })?.runtime;
      return runtime?.hooks ? Object.values(runtime.hooks.hooks) : [];
    },
    async hooksRegister(h) {
      await client.request("hooks.register", h);
    },
    async hooksRemove(id) {
      await client.request("hooks.remove", { id });
    },
    async attentionList() {
      const res = await client.request("state.get", {});
      const runtime = (res.payload as { runtime?: { attention?: AttentionRegistry } })?.runtime;
      return runtime?.attention ?? { items: {} };
    },
    async attentionRaise(item) {
      await client.request("attention.raised", item);
    },
    async attentionResolve(id) {
      await client.request("attention.resolved", { id });
    },
    async openSession(opts) {
      const res = await client.request("pi.openSession", opts);
      return res.payload;
    },
    async prompt(m, i, s) {
      const res = await client.request("pi.prompt", { message: m, images: i, streamingBehavior: s });
      return res.payload;
    },
    async abort() {
      const res = await client.request("pi.abort", {});
      return res.payload;
    },
    async getState() {
      const res = await client.request("pi.getState", {});
      return res.payload;
    },
    async getMessages() {
      const res = await client.request("pi.getMessages", {});
      return res.payload as unknown[];
    },
    async getToolOutput(id) {
      const res = await client.request("pi.getToolOutput", { toolCallId: id });
      return res.payload;
    },
    async getModels() {
      const res = await client.request("pi.getModels", {});
      return res.payload as unknown[];
    },
    async setModel(p, id) {
      const res = await client.request("pi.setModel", { provider: p, modelId: id });
      return res.payload;
    },
    async getThinkingLevels() {
      const res = await client.request("pi.getThinkingLevels", {});
      return res.payload as string[];
    },
    async setThinking(l) {
      const res = await client.request("pi.setThinking", { level: l });
      return res.payload;
    },
    async getSettings() {
      const res = await client.request("pi.getSettings", {});
      return res.payload;
    },
    async setSettings(p) {
      const res = await client.request("pi.setSettings", { patch: p });
      return res.payload;
    },
    async setSessionName(n) {
      const res = await client.request("pi.setSessionName", { name: n });
      return res.payload;
    },
    async compact() {
      const res = await client.request("pi.compact", {});
      return res.payload;
    },
    async getTree() {
      const res = await client.request("pi.getTree", {});
      return res.payload;
    },
    async getHistory() {
      const res = await client.request("pi.getHistory", {});
      return res.payload;
    },
    async getTurnChanges(e) {
      const res = await client.request("pi.getTurnChanges", { entryId: e });
      return res.payload;
    },
    async getTurnFileDiff(e, p) {
      const res = await client.request("pi.getTurnFileDiff", { entryId: e, path: p });
      return res.payload;
    },
    async prepareRollback(e) {
      const res = await client.request("pi.prepareRollback", { entryId: e });
      return res.payload;
    },
    async commitRollback(p) {
      const res = await client.request("pi.commitRollback", { planId: p });
      return res.payload;
    },
    async undoRollback() {
      const res = await client.request("pi.undoRollback", {});
      return res.payload;
    },
    async getForkMessages() {
      const res = await client.request("pi.getForkMessages", {});
      return res.payload as unknown[];
    },
    async fork(e) {
      const res = await client.request("pi.fork", { entryId: e });
      return res.payload;
    },
    async clone() {
      const res = await client.request("pi.clone", {});
      return res.payload;
    },
    async generateCommitMessage(c) {
      const res = await client.request("pi.generateCommitMessage", { context: c });
      return res.payload;
    },
    async getRecaps(f) {
      const res = await client.request("pi.getRecaps", { sessionFile: f });
      return res.payload;
    },
    async refreshFromDisk(f) {
      const res = await client.request("pi.refreshFromDisk", { sessionFile: f });
      return (res.payload as { refreshed: boolean }).refreshed;
    },
    async switchTo(f) {
      const res = await client.request("pi.switchTo", { sessionFile: f });
      return res.payload;
    },
    async respondUi(id, r) {
      await client.request("ui.respond", { id, ...((r as any) || {}) });
    },
    onTaskUpdate(cb) {
      const handler = (env: { type: string; payload: unknown }) => {
        if (env.type === "task.created" || env.type === "task.updated" || env.type === "task.removed") {
          client.request("state.get", {}).then((res) => {
            const runtime = (res.payload as { runtime?: { tasks?: { tasks: Record<string, Task> } } })?.runtime;
            cb(runtime?.tasks ? Object.values(runtime.tasks.tasks) : []);
          }).catch(() => {});
        }
      };
      return client.onEvent(handler as never);
    },
    onAttentionUpdate(cb) {
      const handler = (env: { type: string }) => {
        if (env.type === "attention.raised" || env.type === "attention.resolved") {
          client.request("state.get", {}).then((res) => {
            const runtime = (res.payload as { runtime?: { attention?: AttentionRegistry } })?.runtime;
            cb(runtime?.attention ?? { items: {} });
          }).catch(() => {});
        }
      };
      return client.onEvent(handler as never);
    },
    onAgentEvent(cb) {
      return client.onEvent((env) => {
        if (env.type === "pi.event") cb(env.payload);
      });
    },
    onStatus(cb) {
      return client.onEvent((env) => {
        if (env.type === "pi.session.status") cb(env.payload);
      });
    },
  };
}
