import type { RuntimeFacade } from "./runtime-facade";
import type { LocalPiHost } from "./local-pi-host";
import { wireOf, wireStr } from "./store";
import { TaskManager } from "../electron/task-manager";
import { AttentionManager } from "../electron/attention-manager";
import { HookManager } from "../electron/hook-manager";
import type {
  AgentModel,
  AgentState,
  CommandInfo,
  HistoryProjection,
  PromptImage,
  RollbackPlan,
  SessionStats,
  TurnChanges,
  TurnFileDiff,
} from "./bridge";
import type { GeneratedCommitMessage } from "../electron/git-commit-message";
import type { PreparedCommitContext } from "../electron/git";
import type { Recap } from "../electron/recap";
import type { SessionTreeRow } from "../electron/session-tree";
import type { SubagentControlAction } from "../electron/subagents";
import type { ThreadState } from "../electron/threads";
import type { PiSettings } from "./lib/settings-shared";
import { toSettingsPatch } from "./lib/settings-patch";
import type { Task } from "./tasks";
import { toExecutionActivateResult } from "./execution";
import {
  evaluateContract,
  type CheckResult,
  type CompletionContract,
} from "./completion-contracts";

export function createLocalRuntime(opts: {
  taskManager: TaskManager;
  attentionManager: AttentionManager;
  hookManager: HookManager;
  piHost: LocalPiHost;
  contracts: Map<string, CompletionContract>;
}): RuntimeFacade {
  const { taskManager, attentionManager, hookManager, piHost, contracts } = opts;
  return {
    async taskList() { return taskManager.list(); },
    async taskGet(id) { return taskManager.get(id) ?? null; },
    async taskCreate(task) {
      return taskManager.upsert(task);
    },
    async taskUpdate(id, patch) {
      const t = taskManager.get(id);
      if (!t) throw new Error("unknown task");
      return taskManager.upsert({ ...t, ...patch });
    },
    async taskRemove(id) {
      return taskManager.remove(id);
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
    async prompt(m, i, s, f) {
      const behavior = s === "steer" || s === "followUp" ? s : undefined;
      // The facade loosens images to unknown[]; the host needs image
      // payloads, so malformed entries are dropped at this boundary.
      const images = Array.isArray(i)
        ? i.flatMap((entry) => {
            const data = wireStr(wireOf(entry), "data");
            if (!data) return [];
            const mimeType = wireStr(wireOf(entry), "mimeType");
            return [{ data, ...(mimeType ? { mimeType } : {}) }];
          })
        : undefined;
      return piHost.prompt(m, images, behavior, f);
    },
    async abort(sessionFile: string) { return piHost.abort(sessionFile); },
    async goalControl(f: string, a: string) { return piHost.execGoalCommand(f, a); },
    async executionList() { return piHost.listProjectExecutions(); },
    async executionCwdFor(sessionFile) { return piHost.sessionCwdFor(sessionFile); },
    async executionActivate(cwd, sessionFile, opts) {
      try {
        await piHost.activateExecution(cwd, sessionFile, opts);
        const execution = await piHost.executionSnapshot(cwd);
        if (!execution) throw new Error("activation produced no execution record");
        return { ok: true as const, execution };
      } catch (e) {
        const busy = toExecutionActivateResult(e);
        if (busy) return busy;
        throw e;
      }
    },
    async executionDeactivate(cwd, expected) { return piHost.deactivateExecution(cwd, expected); },
    async relocateExecution(sessionFile, fromCwd, toCwd) { return piHost.relocateExecution(sessionFile, fromCwd, toCwd); },
    async beginGoalPrompt(f: string, o: string, m: string, i?: unknown[], s?: string) {
      const behavior = s === "steer" || s === "followUp" ? s : undefined;
      // Same image sanitization as prompt(): malformed entries are dropped
      // at this boundary, never forwarded to the host.
      const images = Array.isArray(i)
        ? i.flatMap((entry) => {
            const data = wireStr(wireOf(entry), "data");
            if (!data) return [];
            const mimeType = wireStr(wireOf(entry), "mimeType");
            return [{ data, ...(mimeType ? { mimeType } : {}) }];
          })
        : undefined;
      return piHost.beginGoalPrompt(f, o, m, images, behavior);
    },
    async designControl(f: string, a: string) { return piHost.execDesignCommand(f, a); },
    async beginDesignPrompt(f: string, s: string, m: string, i?: unknown[], b?: string) {
      const behavior = b === "steer" || b === "followUp" ? b : undefined;
      const images = Array.isArray(i)
        ? i.flatMap((entry) => {
            const data = wireStr(wireOf(entry), "data");
            if (!data) return [];
            const mimeType = wireStr(wireOf(entry), "mimeType");
            return [{ data, ...(mimeType ? { mimeType } : {}) }];
          })
        : undefined;
      return piHost.beginDesignPrompt(f, s, m, images, behavior);
    },
    async getState(sessionFile) { return piHost.getState(sessionFile); },
    async getMessages(sessionFile) { return piHost.getMessages(sessionFile); },
    async getToolOutput(sessionFile, id) { return piHost.getToolOutput(sessionFile, id); },
    async getModels(cwd) { return piHost.getModels(cwd); },
    async warmProject(cwd) { return piHost.warmProject(cwd); },
    async setModel(f, p, id) { return piHost.setModel(f, p, id); },
    async getThinkingLevels(sessionFile) { return piHost.getThinkingLevels(sessionFile); },
    async setThinking(f, l) { return piHost.setThinking(f, l); },
    async getSettings() { return piHost.getSettings(); },
    async setSettings(p) {
      // The renderer sends a partial settings object: validate it the same
      // way the daemon socket does, so malformed fields reject here instead
      // of merging through into persistence.
      return piHost.setSettings(toSettingsPatch(p));
    },
    async setSessionName(f, n) { return piHost.setSessionName(f, n); },
    async renameSession(f, n) { return piHost.renameSession(f, n); },
    async compact(f, c) { return piHost.compact(f, c); },
    async getTree(sessionFile) { return piHost.getTree(sessionFile); },
    async getHistory(sessionFile) { return piHost.getHistory(sessionFile); },
    async getTurnChanges(sessionFile, e) { return piHost.getTurnChanges(sessionFile, e); },
    async getTurnFileDiff(sessionFile, e, p) { return piHost.getTurnFileDiff(sessionFile, e, p); },
    async prepareRollback(f, e) { return piHost.prepareRollback(f, e); },
    async commitRollback(p) { return piHost.commitRollback(p); },
    async undoRollback(f) { return piHost.undoRollback(f); },
    async getForkMessages(sessionFile) { return piHost.getForkMessages(sessionFile); },
    async fork(f, e) { return piHost.fork(f, e); },
    async clone(f) { return piHost.clone(f); },
    async generateCommitMessage(c) { return piHost.generateGitCommitMessage(c); },
    async getRecaps(f) { return piHost.getRecaps(f); },
    async refreshFromDisk(f) { return piHost.refreshFromDisk(f); },
    async respondUi(id, r) { return piHost.respondUi(id, r); },
    async getCommands(sessionFile) { return piHost.getCommands(sessionFile); },
    async controlThread(a, id, m) { return piHost.controlThread(a, id, m); },
    async promoteThread(id) { return piHost.promoteThread(id); },
    async controlSubagent(a, id, m) { return piHost.controlSubagent(a, id, m); },
    async promoteSubagent(id) { return piHost.promoteSubagent(id); },
    async getStats(sessionFile) { return piHost.getStats(sessionFile); },
    onTaskUpdate(cb) { return taskManager.subscribe(cb); },
    onAttentionUpdate(cb) { return attentionManager.subscribe(cb); },
    onAgentEvent() { return () => {}; },
  };
}
