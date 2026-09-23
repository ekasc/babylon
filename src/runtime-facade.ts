import type { Task } from "./tasks";
import type { AgentState, HistoryProjection, TurnChanges, TurnFileDiff, RollbackPlan } from "./bridge";
import type { PreparedCommitContext } from "../electron/git";
import type { GeneratedCommitMessage } from "../electron/git-commit-message";
import type { Recap } from "../electron/recap";
import type { SessionTreeRow } from "../electron/session-tree";
import type { SubagentControlAction } from "../electron/subagents";
import type { ThreadState } from "../electron/threads";
import type {
  AgentModel,
  CommandInfo,
  PromptImage,
  SessionStats,
} from "./bridge";
import type { PiSettings } from "./lib/settings-shared";
import type { DurableGoalState } from "./lib/durable-goal";
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
  openSession(opts: { path?: string; cwd: string; requestId?: number; systemPrompt?: string | null }): Promise<unknown>;
  /** Explicit sessionFile wins over the foreground pointer (send-while-switching). */
  prompt(message: string, images?: unknown[], streamingBehavior?: string, sessionFile?: string | null): Promise<unknown>;
  abort(sessionFile?: string): Promise<unknown>;
  releaseSession?(path: string): Promise<{ released: boolean }>;
  getState(): Promise<AgentState | null>;
  getMessages(): Promise<unknown[]>;
  getToolOutput(toolCallId: string): Promise<unknown>;
  getModels(): Promise<unknown[]>;
  /** Idempotent pre-warm of a project (rollback shadow + model runtime). */
  warmProject(cwd: string): Promise<unknown>;
  setModel(provider: string, modelId: string): Promise<unknown>;
  getThinkingLevels(): Promise<string[]>;
  setThinking(level: string): Promise<unknown>;
  getSettings(): Promise<unknown>;
  setSettings(patch: unknown): Promise<unknown>;
  setSessionName(name: string): Promise<unknown>;
  compact(): Promise<unknown>;
  getTree(): Promise<unknown>;
  getHistory(): Promise<HistoryProjection>;
  getTurnChanges(entryId: string): Promise<TurnChanges>;
  getTurnFileDiff(entryId: string, path: string): Promise<TurnFileDiff>;
  prepareRollback(entryId: string): Promise<RollbackPlan>;
  commitRollback(planId: string): Promise<{ editorText: string; history: HistoryProjection }>;
  undoRollback(): Promise<{ history: HistoryProjection }>;
  getForkMessages(): Promise<unknown[]>;
  fork(entryId: string): Promise<{ text?: string; cancelled?: boolean }>;
  clone(): Promise<{ cancelled?: boolean }>;
  generateCommitMessage(context: PreparedCommitContext): Promise<GeneratedCommitMessage>;
  getRecaps(sessionFile: string): Promise<unknown>;
  refreshFromDisk(sessionFile: string): Promise<boolean>;
  switchTo(sessionFile: string): Promise<AgentState>;
  respondUi(id: string, resp: unknown): Promise<void>;
  getCommands(): Promise<unknown[]>;
  getActiveSessionFile(): Promise<string | null>;
  controlThread(action: "steer" | "follow-up" | "stop", threadId: string, message?: string): Promise<unknown>;
  promoteThread(threadId: string): Promise<unknown>;
  controlSubagent(action: "steer" | "follow-up" | "stop", runId: string, message?: string): Promise<unknown>;
  promoteSubagent(runId: string): Promise<unknown>;
  getStats(): Promise<unknown>;
  /** Run a `/goal …` control invocation without opening a turn; returns the fresh durable goal. */
  goalControl(args: string): Promise<DurableGoalState | null>;
  /** Run a `/design …` control invocation; returns the fresh design state. */
  designControl(args: string): Promise<import("../electron/design-mode/store").DesignStatus>;
  // Lifecycle
  onTaskUpdate(cb: (tasks: Task[]) => void): () => void;
  onAttentionUpdate(cb: (reg: AttentionRegistry) => void): () => void;
  onAgentEvent(cb: (ev: unknown) => void): () => void;
  onStatus(cb: (s: unknown) => void): () => void;
}
