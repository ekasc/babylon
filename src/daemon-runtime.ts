import type { RuntimeFacade } from "./runtime-facade";
import type {
  AgentModel,
  AgentState,
  HistoryProjection,
  HistoryTurn,
  RollbackPlan,
  TurnChanges,
  TurnFileChange,
  TurnFileDiff,
} from "./bridge";
import { isArrayOf, isString, wireArr, wireNum, wireOf, wireStr } from "./store";
import type { Task } from "./tasks";
import type { CompletionContract } from "./completion-contracts";
import type { HookDefinition } from "./hooks";
import type { AttentionRegistry } from "./attention";
import type { DaemonClient } from "./daemon-client";
import { unwrapDurableGoalResult } from "./lib/durable-goal";
import { unwrapDesignResult } from "../electron/design-mode/store";

/**
 * Socket-payload validators. The daemon speaks over a local socket, and a
 * stale or foreign daemon can send anything — so every payload is validated
 * field by field here instead of asserted. A violation throws (fail loud at
 * the boundary) rather than letting malformed data reach the transcript.
 */
function malformed(type: string): Error {
  return new Error(`${type} returned a malformed payload`);
}

function asRecord(payload: unknown, type: string): Record<string, unknown> {
  const wire = wireOf(payload);
  if (!wire) throw malformed(type);
  return wire;
}

function reqStr(wire: Record<string, unknown>, type: string, key: string): string {
  const v = wire[key];
  if (typeof v !== "string") throw malformed(type);
  return v;
}

function reqNum(wire: Record<string, unknown>, type: string, key: string): number {
  const v = wire[key];
  if (typeof v !== "number") throw malformed(type);
  return v;
}

function reqBool(wire: Record<string, unknown>, type: string, key: string): boolean {
  const v = wire[key];
  if (typeof v !== "boolean") throw malformed(type);
  return v;
}

function reqArr(wire: Record<string, unknown>, type: string, key: string): unknown[] {
  const v = wire[key];
  if (!Array.isArray(v)) throw malformed(type);
  return v;
}

function toHistoryTurn(value: unknown, type: string): HistoryTurn {
  const w = asRecord(value, type);
  return {
    entryId: reqStr(w, type, "entryId"),
    parentUserEntryId: w.parentUserEntryId === null ? null : reqStr(w, type, "parentUserEntryId"),
    index: reqNum(w, type, "index"),
    depth: reqNum(w, type, "depth"),
    text: reqStr(w, type, "text"),
    response: reqStr(w, type, "response"),
    onActivePath: reqBool(w, type, "onActivePath"),
    current: reqBool(w, type, "current"),
    branchCount: reqNum(w, type, "branchCount"),
    changedCount: reqNum(w, type, "changedCount"),
    checkpointAvailable: reqBool(w, type, "checkpointAvailable"),
    rollbackAvailable: reqBool(w, type, "rollbackAvailable"),
    ...(typeof w.rollbackReason === "string" ? { rollbackReason: w.rollbackReason } : {}),
  };
}

function toHistoryProjection(value: unknown, type: string): HistoryProjection {
  const w = asRecord(value, type);
  const leafId = w.leafId === null ? null : reqStr(w, type, "leafId");
  const activeRaw = w.activeRollback === undefined ? undefined : asRecord(w.activeRollback, type);
  return {
    turns: reqArr(w, type, "turns").map((t) => toHistoryTurn(t, type)),
    leafId,
    hasBranches: reqBool(w, type, "hasBranches"),
    ...(activeRaw
      ? {
          activeRollback: {
            targetUserEntryId: reqStr(activeRaw, type, "targetUserEntryId"),
            abandonedCount: reqNum(activeRaw, type, "abandonedCount"),
            fileCount: reqNum(activeRaw, type, "fileCount"),
            editorText: reqStr(activeRaw, type, "editorText"),
            createdAt: reqStr(activeRaw, type, "createdAt"),
            undoAvailable: reqBool(activeRaw, type, "undoAvailable"),
            ...(typeof activeRaw.undoReason === "string" ? { undoReason: activeRaw.undoReason } : {}),
          },
        }
      : {}),
  };
}

function toTurnFileChange(value: unknown, type: string): TurnFileChange {
  const w = asRecord(value, type);
  const rawKind = w.kind;
  const kind = rawKind === "added" || rawKind === "modified" || rawKind === "deleted" ? rawKind : undefined;
  if (kind === undefined) throw malformed(type);
  return {
    path: reqStr(w, type, "path"),
    kind,
    additions: reqNum(w, type, "additions"),
    deletions: reqNum(w, type, "deletions"),
  };
}

function toTurnChanges(value: unknown, type: string): TurnChanges {
  const w = asRecord(value, type);
  const totals = asRecord(w.totals, type);
  const exclusions = reqArr(w, type, "exclusions");
  return {
    userEntryId: reqStr(w, type, "userEntryId"),
    files: reqArr(w, type, "files").map((f) => toTurnFileChange(f, type)),
    totals: {
      files: reqNum(totals, type, "files"),
      additions: reqNum(totals, type, "additions"),
      deletions: reqNum(totals, type, "deletions"),
    },
    exclusions: exclusions.map((e) => {
      if (typeof e !== "string") throw malformed(type);
      return e;
    }),
  };
}

function toTurnFileDiff(value: unknown, type: string): TurnFileDiff {
  const w = asRecord(value, type);
  return { diff: reqStr(w, type, "diff"), truncated: reqBool(w, type, "truncated") };
}

function toRollbackPlan(value: unknown, type: string): RollbackPlan {
  const w = asRecord(value, type);
  const counts = asRecord(w.counts, type);
  const changes = reqArr(w, type, "changes").map((c) => {
    const cw = asRecord(c, type);
    const rawStatus: unknown = cw.status;
    const status: "added" | "modified" | "deleted" | undefined =
      rawStatus === "added" || rawStatus === "modified" || rawStatus === "deleted" ? rawStatus : undefined;
    if (status === undefined) throw malformed(type);
    return { path: reqStr(cw, type, "path"), status };
  });
  return {
    planId: reqStr(w, type, "planId"),
    targetUserEntryId: reqStr(w, type, "targetUserEntryId"),
    targetText: reqStr(w, type, "targetText"),
    abandonedCount: reqNum(w, type, "abandonedCount"),
    changes,
    counts: {
      added: reqNum(counts, type, "added"),
      modified: reqNum(counts, type, "modified"),
      deleted: reqNum(counts, type, "deleted"),
    },
    expiresAt: reqStr(w, type, "expiresAt"),
  };
}

function toAgentModel(value: unknown, type: string): AgentModel {
  const w = asRecord(value, type);
  const costRaw = w.cost === undefined ? undefined : asRecord(w.cost, type);
  const cost = costRaw
    ? {
        ...(typeof costRaw.input === "number" ? { input: costRaw.input } : {}),
        ...(typeof costRaw.output === "number" ? { output: costRaw.output } : {}),
        ...(typeof costRaw.cacheRead === "number" ? { cacheRead: costRaw.cacheRead } : {}),
      }
    : undefined;
  const inputRaw = w.input;
  return {
    provider: reqStr(w, type, "provider"),
    id: reqStr(w, type, "id"),
    ...(typeof w.name === "string" ? { name: w.name } : {}),
    ...(typeof w.contextWindow === "number" ? { contextWindow: w.contextWindow } : {}),
    ...(cost ? { cost } : {}),
    ...(typeof w.reasoning === "boolean" ? { reasoning: w.reasoning } : {}),
    ...(typeof w.supportsImages === "boolean" ? { supportsImages: w.supportsImages } : {}),
    ...(typeof w.vision === "boolean" ? { vision: w.vision } : {}),
    ...(isArrayOf(inputRaw, isString) ? { input: inputRaw } : {}),
  };
}

function toAgentState(value: unknown, type: string): AgentState {
  const w = asRecord(value, type);
  const modelRaw = w.model;
  const gitWorktreeBranch = wireStr(wireOf(w.gitWorktree), "branch");
  const gitBranch = wireStr(wireOf(w.git), "branch");
  return {
    ...(modelRaw === null || modelRaw === undefined ? {} : { model: toAgentModel(modelRaw, type) }),
    ...(typeof w.thinkingLevel === "string" ? { thinkingLevel: w.thinkingLevel } : {}),
    ...(typeof w.isStreaming === "boolean" ? { isStreaming: w.isStreaming } : {}),
    ...(typeof w.isCompacting === "boolean" ? { isCompacting: w.isCompacting } : {}),
    ...(typeof w.sessionFile === "string" || w.sessionFile === null ? { sessionFile: w.sessionFile } : {}),
    ...(typeof w.sessionId === "string" ? { sessionId: w.sessionId } : {}),
    ...(typeof w.sessionName === "string" ? { sessionName: w.sessionName } : {}),
    ...(typeof w.autoCompactionEnabled === "boolean" ? { autoCompactionEnabled: w.autoCompactionEnabled } : {}),
    ...(typeof w.messageCount === "number" ? { messageCount: w.messageCount } : {}),
    ...(typeof w.pendingMessageCount === "number" ? { pendingMessageCount: w.pendingMessageCount } : {}),
    ...(w.gitWorktree !== undefined
      ? { gitWorktree: { ...(gitWorktreeBranch !== undefined ? { branch: gitWorktreeBranch } : {}) } }
      : {}),
    ...(w.git !== undefined
      ? { git: { ...(gitBranch !== undefined ? { branch: gitBranch } : {}) } }
      : {}),
  };
}

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
    async prompt(m, i, s, f) {
      const res = await client.request("pi.prompt", { message: m, images: i, streamingBehavior: s, sessionFile: f ?? undefined });
      return res.payload;
    },
    async abort(sessionFile?: string) {
      const res = await client.request("pi.abort", { sessionFile });
      return res.payload;
    },
    async goalControl(args) {
      const res = await client.request("pi.goalControl", { args });
      return unwrapDurableGoalResult(res.payload, "pi.goalControl");
    },
    async designControl(args) {
      const res = await client.request("pi.designControl", { args });
      return unwrapDesignResult(res.payload, "pi.designControl");
    },
    async getState() {
      const res = await client.request("pi.getState", {});
      return res.payload;
    },
    async getMessages() {
      const res = await client.request("pi.getMessages", {});
      return (res.payload as { messages?: unknown[] }).messages ?? [];
    },
    async getToolOutput(id) {
      const res = await client.request("pi.getToolOutput", { toolCallId: id });
      return res.payload;
    },
    async getModels() {
      const res = await client.request("pi.getModels", {});
      return (res.payload as { models?: unknown[] }).models ?? [];
    },
    async warmProject(cwd) {
      const res = await client.request("pi.warmProject", { cwd });
      return res.payload;
    },
    async setModel(p, id) {
      const res = await client.request("pi.setModel", { provider: p, modelId: id });
      return res.payload;
    },
    async getThinkingLevels() {
      const res = await client.request("pi.getThinkingLevels", {});
      return (res.payload as { levels?: string[] }).levels ?? [];
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
      return toHistoryProjection(res.payload, "pi.getHistory");
    },
    async getTurnChanges(e) {
      const res = await client.request("pi.getTurnChanges", { entryId: e });
      return toTurnChanges(res.payload, "pi.getTurnChanges");
    },
    async getTurnFileDiff(e, p) {
      const res = await client.request("pi.getTurnFileDiff", { entryId: e, path: p });
      return toTurnFileDiff(res.payload, "pi.getTurnFileDiff");
    },
    async prepareRollback(e) {
      const res = await client.request("pi.prepareRollback", { entryId: e });
      return toRollbackPlan(res.payload, "pi.prepareRollback");
    },
    async commitRollback(p) {
      const res = await client.request("pi.commitRollback", { planId: p });
      {
        const record = asRecord(res.payload, "pi.commitRollback");
        return { editorText: reqStr(record, "pi.commitRollback", "editorText"), history: toHistoryProjection(record.history, "pi.commitRollback") };
      }
    },
    async undoRollback() {
      const res = await client.request("pi.undoRollback", {});
      {
        const record = asRecord(res.payload, "pi.undoRollback");
        return { history: toHistoryProjection(record.history, "pi.undoRollback") };
      }
    },
    async getForkMessages() {
      const res = await client.request("pi.getForkMessages", {});
      return (res.payload as { messages?: unknown[] }).messages ?? [];
    },
    async fork(e) {
      const res = await client.request("pi.fork", { entryId: e });
      {
        const record = asRecord(res.payload, "pi.fork");
        const text = record.text;
        const cancelled = record.cancelled;
        if (text !== undefined && typeof text !== "string") throw malformed("pi.fork");
        if (cancelled !== undefined && typeof cancelled !== "boolean") throw malformed("pi.fork");
        return { ...(typeof text === "string" ? { text } : {}), ...(typeof cancelled === "boolean" ? { cancelled } : {}) };
      }
    },
    async clone() {
      const res = await client.request("pi.clone", {});
      {
        const record = asRecord(res.payload, "pi.clone");
        const cancelled = record.cancelled;
        if (cancelled !== undefined && typeof cancelled !== "boolean") throw malformed("pi.clone");
        return { ...(typeof cancelled === "boolean" ? { cancelled } : {}) };
      }
    },
    async generateCommitMessage(c) {
      const res = await client.request("pi.generateCommitMessage", { context: c });
      // The daemon runs the same model pipeline as the local host, so the
      // payload has the generated subject/body/message; anything else is a
      // protocol violation rather than something to guess at.
      const payload = res.payload;
      if (
        typeof payload !== "object" ||
        payload === null ||
        typeof (payload as { subject?: unknown }).subject !== "string" ||
        typeof (payload as { body?: unknown }).body !== "string" ||
        typeof (payload as { message?: unknown }).message !== "string"
      ) {
        throw new Error("pi.generateCommitMessage returned a malformed payload");
      }
      const checked = payload as { subject: string; body: string; message: string };
      return { subject: checked.subject, body: checked.body, message: checked.message };
    },
    async getRecaps(f) {
      const res = await client.request("pi.getRecaps", { sessionFile: f });
      return (res.payload as { recaps?: unknown }).recaps ?? [];
    },
    async refreshFromDisk(f) {
      const res = await client.request("pi.refreshFromDisk", { sessionFile: f });
      return (res.payload as { refreshed: boolean }).refreshed;
    },
    async switchTo(f) {
      const res = await client.request("pi.switchTo", { sessionFile: f });
      return toAgentState(res.payload, "pi.switchTo");
    },
    async respondUi(id, r) {
      await client.request("pi.ui.respond", { id, resp: r });
    },
    async getCommands() {
      const res = await client.request("pi.getCommands", {});
      return (res.payload as { commands?: unknown[] })?.commands ?? [];
    },
    async getActiveSessionFile() {
      const res = await client.request("pi.getActiveSessionFile", {});
      return (res.payload as { path?: string | null })?.path ?? null;
    },
    async controlThread(action, threadId, message) {
      const res = await client.request("pi.controlThread", { action, threadId, message });
      return res.payload;
    },
    async promoteThread(threadId) {
      const res = await client.request("pi.promoteThread", { threadId });
      return res.payload;
    },
    async controlSubagent(action, runId, message) {
      const res = await client.request("pi.controlSubagent", { action, runId, message });
      return res.payload;
    },
    async promoteSubagent(runId) {
      const res = await client.request("pi.promoteSubagent", { runId });
      return res.payload;
    },
    async getStats() {
      const res = await client.request("pi.getStats", {});
      return res.payload;
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
      return client.onEvent(handler);
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
      return client.onEvent(handler);
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
