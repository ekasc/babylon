import type { Task } from "./tasks";
import type { AttentionRegistry } from "./attention";
import type { HookDefinition } from "./hooks";
import type { CheckResult, CompletionContract, ContractEvaluation } from "./completion-contracts";

export interface RuntimeFacade {
  // Tasks
  taskList(): Promise<Task[]>;
  taskGet(id: string): Promise<Task | null>;
  taskCreate(task: Task): Promise<Task>;
  taskUpdate(id: string, patch: Partial<Task>): Promise<Task>;
  taskRemove(id: string): Promise<boolean>;
  // Contracts
  contractGet(id: string): Promise<CompletionContract | null>;
  contractSet(contract: CompletionContract): Promise<void>;
  contractsList(): Promise<CompletionContract[]>;
  /** Evaluate the task's completion contract (when set) and mark completed. */
  taskComplete(id: string, results: CheckResult[]): Promise<{ blocked: boolean; reason?: string; evaluation?: ContractEvaluation }>;
  // Hooks
  hooksList(): Promise<HookDefinition[]>;
  hooksRegister(hook: HookDefinition): Promise<void>;
  hooksRemove(id: string): Promise<void>;
  // Attention
  attentionList(): Promise<AttentionRegistry>;
  attentionRaise(item: import("./attention").AttentionItem): Promise<void>;
  attentionResolve(id: string): Promise<void>;
  // Pi
  openSession(opts: { path?: string; cwd: string; requestId?: number }): Promise<unknown>;
  prompt(message: string, images?: unknown[], streamingBehavior?: string): Promise<unknown>;
  abort(): Promise<unknown>;
  getState(): Promise<unknown>;
  getMessages(): Promise<unknown[]>;
  getToolOutput(toolCallId: string): Promise<unknown>;
  getModels(): Promise<unknown[]>;
  setModel(provider: string, modelId: string): Promise<unknown>;
  getThinkingLevels(): Promise<string[]>;
  setThinking(level: string): Promise<unknown>;
  getSettings(): Promise<unknown>;
  setSettings(patch: unknown): Promise<unknown>;
  setSessionName(name: string): Promise<unknown>;
  compact(): Promise<unknown>;
  getTree(): Promise<unknown>;
  getHistory(): Promise<unknown>;
  getTurnChanges(entryId: string): Promise<unknown>;
  getTurnFileDiff(entryId: string, path: string): Promise<unknown>;
  prepareRollback(entryId: string): Promise<unknown>;
  commitRollback(planId: string): Promise<unknown>;
  undoRollback(): Promise<unknown>;
  getForkMessages(): Promise<unknown[]>;
  fork(entryId: string): Promise<unknown>;
  clone(): Promise<unknown>;
  generateCommitMessage(context: unknown): Promise<unknown>;
  getRecaps(sessionFile: string): Promise<unknown>;
  refreshFromDisk(sessionFile: string): Promise<boolean>;
  switchTo(sessionFile: string): Promise<unknown>;
  respondUi(id: string, resp: unknown): Promise<void>;
  getCommands(): Promise<unknown[]>;
  getActiveSessionFile(): Promise<string | null>;
  controlThread(action: "steer" | "follow-up" | "stop", threadId: string, message?: string): Promise<unknown>;
  promoteThread(threadId: string): Promise<unknown>;
  controlSubagent(action: "steer" | "follow-up" | "stop", runId: string, message?: string): Promise<unknown>;
  promoteSubagent(runId: string): Promise<unknown>;
  getStats(): Promise<unknown>;
  // Lifecycle
  onTaskUpdate(cb: (tasks: Task[]) => void): () => void;
  onAttentionUpdate(cb: (reg: AttentionRegistry) => void): () => void;
  onAgentEvent(cb: (ev: unknown) => void): () => void;
  onStatus(cb: (s: unknown) => void): () => void;
}
