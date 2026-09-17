import type { RuntimeFacade } from "./runtime-facade";
import { TaskManager } from "../electron/task-manager";
import { AttentionManager } from "../electron/attention-manager";
import { HookManager } from "../electron/hook-manager";
import { PiHost } from "../electron/pi-host";
import type { Task } from "./tasks";
import type { PiSettings } from "./lib/settings-shared";
import {
  evaluateContract,
  type CheckResult,
  type CompletionContract,
} from "./completion-contracts";

export function createLocalRuntime(opts: {
  taskManager: TaskManager;
  attentionManager: AttentionManager;
  hookManager: HookManager;
  piHost: PiHost;
  contracts: Map<string, CompletionContract>;
}): RuntimeFacade {
  const { taskManager, attentionManager, hookManager, piHost, contracts } = opts;
  return {
    async taskList() { return taskManager.list(); },
    async taskGet(id) { return taskManager.get(id) ?? null; },
    async taskCreate(task) {
      // Use TaskManager's register via direct add to avoid private access
      // TaskManager doesn't have a direct create from Task, so we use its internal registry via taskManager's public API
      // For local, we can just add via taskManager's register if task matches TaskResources, otherwise directly insert
      (taskManager as unknown as { registry: { tasks: Record<string, Task> } }).registry.tasks[task.id] = task;
      (taskManager as unknown as { broadcast(): void }).broadcast();
      return task;
    },
    async taskUpdate(id, patch) {
      const t = taskManager.get(id);
      if (!t) throw new Error("unknown task");
      (taskManager as unknown as { registry: { tasks: Record<string, Task> } }).registry.tasks[id] = { ...t, ...patch } as Task;
      (taskManager as unknown as { broadcast(): void }).broadcast();
      return taskManager.get(id)!;
    },
    async taskRemove(id) {
      const before = taskManager.get(id);
      if (!before) return false;
      (taskManager as unknown as { registry: { tasks: Record<string, Task> } }).registry.tasks = Object.fromEntries(
        Object.entries((taskManager as unknown as { registry: { tasks: Record<string, Task> } }).registry.tasks).filter(([k]) => k !== id)
      );
      (taskManager as unknown as { broadcast(): void }).broadcast();
      return true;
    },
    async contractGet(id) { return contracts.get(id) ?? null; },
    async contractSet(c) { contracts.set(c.id, c); },
    async contractsList() { return [...contracts.values()]; },
    async taskComplete(id, results: CheckResult[]) {
      const task = taskManager.get(id);
      if (!task) throw new Error("unknown task");
      const contractId = (task as { contractId?: string }).contractId;
      const contract = contractId ? contracts.get(contractId) : undefined;
      if (contract) {
        const evaluation = evaluateContract(contract, results);
        if (!evaluation.passed) {
          const failed = evaluation.checks
            .filter((c) => c.check.required && !c.satisfied)
            .map((c) => c.check.label);
          attentionManager.add({
            id: `contract-${id}-${Date.now()}`,
            type: "failed_task",
            title: `Completion blocked: ${contract.title}`,
            detail: failed.length ? `contract failed: ${failed.join(", ")}` : "contract failed",
            source: id,
            createdAt: Date.now(),
            resolved: false,
          });
          return {
            blocked: true,
            reason: failed.length ? `contract failed: ${failed.join(", ")}` : "contract failed",
            evaluation,
          };
        }
        taskManager.markCompleted(id);
        return { blocked: false, evaluation };
      }
      taskManager.markCompleted(id);
      return { blocked: false };
    },
    async hooksList() { return hookManager.list(); },
    async hooksRegister(h) { hookManager.register(h); },
    async hooksRemove(id) { hookManager.remove(id); },
    async attentionList() { return attentionManager.list(); },
    async attentionRaise(item) { attentionManager.add(item); },
    async attentionResolve(id) { attentionManager.resolve(id); },
    async openSession(o) { return piHost.open(o); },
    async prompt(m, i, s) {
      const behavior = s === "steer" || s === "followUp" ? s : undefined;
      return piHost.prompt(m, i, behavior);
    },
    async abort(sessionFile?: string) { return piHost.abort(sessionFile); },
    async releaseSession(path: string) { return (piHost as any).releaseSession?.(path) ?? { released: false }; },
    async getState() { return piHost.getState(); },
    async getMessages() { return piHost.getMessages(); },
    async getToolOutput(id) { return piHost.getToolOutput(id); },
    async getModels() { return piHost.getModels(); },
    async warmProject(cwd) { return piHost.warmProject(cwd); },
    async setModel(p, id) { return piHost.setModel(p, id); },
    async getThinkingLevels() { return piHost.getThinkingLevels(); },
    async setThinking(l) { return piHost.setThinking(l); },
    async getSettings() { return piHost.getSettings(); },
    async setSettings(p) {
      // The renderer sends a partial settings object and `saveSettings` merges
      // it over defaults; enforce object-ness here. Per-field validation is not
      // done (pre-existing), so a malformed field is still merged through.
      return piHost.setSettings(p !== null && typeof p === "object" && !Array.isArray(p) ? (p as Partial<PiSettings>) : {});
    },
    async setSessionName(n) { return piHost.setSessionName(n); },
    async compact() { return piHost.compact(); },
    async getTree() { return piHost.getTree(); },
    async getHistory() { return piHost.getHistory(); },
    async getTurnChanges(e) { return piHost.getTurnChanges(e); },
    async getTurnFileDiff(e, p) { return piHost.getTurnFileDiff(e, p); },
    async prepareRollback(e) { return piHost.prepareRollback(e); },
    async commitRollback(p) { return piHost.commitRollback(p); },
    async undoRollback() { return piHost.undoRollback(); },
    async getForkMessages() { return piHost.getForkMessages(); },
    async fork(e) { return piHost.fork(e); },
    async clone() { return piHost.clone(); },
    async generateCommitMessage(c) { return (piHost as any).generateGitCommitMessage(c); },
    async getRecaps(f) { return piHost.getRecaps(f); },
    async refreshFromDisk(f) { return piHost.refreshFromDisk(f); },
    async switchTo(f) { return (piHost as any).switchTo(f); },
    async respondUi(id, r) { return piHost.respondUi(id, r as any); },
    async getCommands() { return (piHost as any).getCommands?.() ?? []; },
    async getActiveSessionFile() { return (piHost as any).activeSessionFile ?? null; },
    async controlThread(a, id, m) { return (piHost as any).controlThread(a, id, m); },
    async promoteThread(id) { return (piHost as any).promoteThread(id); },
    async controlSubagent(a, id, m) { return (piHost as any).controlSubagent(a, id, m); },
    async promoteSubagent(id) { return (piHost as any).promoteSubagent(id); },
    async getStats() { return (piHost as any).getStats?.(); },
    onTaskUpdate(cb) { return taskManager.subscribe(cb); },
    onAttentionUpdate(cb) { return attentionManager.subscribe(cb); },
    onAgentEvent() { return () => {}; },
    onStatus() { return () => {}; },
  };
}
