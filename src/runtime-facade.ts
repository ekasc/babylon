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
  prompt(message: string, images: unknown[] | undefined, streamingBehavior: string | undefined, sessionFile: string): Promise<unknown>;
  abort(sessionFile: string): Promise<unknown>;
  releaseSession?(path: string): Promise<{ released: boolean }>;
  getState(sessionFile: string): Promise<AgentState | null>;
  getMessages(sessionFile: string): Promise<unknown[]>;
  getToolOutput(sessionFile: string, toolCallId: string): Promise<unknown>;
  getModels(cwd: string): Promise<unknown[]>;
  /** Idempotent pre-warm of a project (rollback shadow + model runtime). */
  warmProject(cwd: string): Promise<unknown>;
  setModel(sessionFile: string, provider: string, modelId: string): Promise<unknown>;
  getThinkingLevels(sessionFile: string): Promise<string[]>;
  setThinking(sessionFile: string, level: string): Promise<unknown>;
  getSettings(): Promise<unknown>;
  setSettings(patch: unknown): Promise<unknown>;
  setSessionName(sessionFile: string, name: string): Promise<unknown>;
  /** Path-addressed rename: retained sessions go through their live runtime,
   *  never-opened files get a session_info append. Never moves foreground. */
  renameSession(sessionFile: string, name: string): Promise<unknown>;
  compact(sessionFile: string, customInstructions?: string): Promise<unknown>;
  getTree(sessionFile: string): Promise<unknown>;
  getHistory(sessionFile: string): Promise<HistoryProjection>;
  getTurnChanges(sessionFile: string, entryId: string): Promise<TurnChanges>;
  getTurnFileDiff(sessionFile: string, entryId: string, path: string): Promise<TurnFileDiff>;
  prepareRollback(sessionFile: string, entryId: string): Promise<RollbackPlan>;
  commitRollback(planId: string): Promise<{ editorText: string; history: HistoryProjection }>;
  undoRollback(sessionFile: string): Promise<{ history: HistoryProjection }>;
  getForkMessages(sessionFile: string): Promise<unknown[]>;
  fork(sessionFile: string, entryId: string): Promise<{ text?: string; cancelled?: boolean }>;
  clone(sessionFile: string): Promise<{ cancelled?: boolean; sessionFile?: string }>;
  generateCommitMessage(context: PreparedCommitContext): Promise<GeneratedCommitMessage>;
  getRecaps(sessionFile: string): Promise<unknown>;
  refreshFromDisk(sessionFile: string): Promise<boolean>;
  switchTo(sessionFile: string): Promise<AgentState>;
  respondUi(id: string, resp: unknown): Promise<void>;
  getCommands(sessionFile: string): Promise<unknown[]>;

  controlThread(action: "steer" | "follow-up" | "stop", threadId: string, message?: string): Promise<unknown>;
  promoteThread(threadId: string): Promise<unknown>;
  controlSubagent(action: "steer" | "follow-up" | "stop", runId: string, message?: string): Promise<unknown>;
  promoteSubagent(runId: string): Promise<unknown>;
  getStats(sessionFile: string): Promise<unknown>;
  /** Run a `/goal …` control invocation without opening a turn; returns the fresh durable goal. */
  goalControl(sessionFile: string, args: string): Promise<DurableGoalState | null>;
  /** Current execution records for every project slot (renderer rebuilds its
   *  Record<cwd, ProjectExecution> on startup/reconnect). */
  executionList(): Promise<import("./execution").ProjectExecution[]>;
  /** Acquire/transfer a project's execution slot; busy owners come back as a
   *  structured envelope (errors do not survive message-only transports). */
  executionActivate(cwd: string, sessionFile?: string): Promise<import("./execution").ExecutionActivateResult>;
  executionDeactivate(cwd: string, expectedSessionFile: string): Promise<boolean>;
  /** Silently persist a goal objective for an addressed session (no follow-up turn). */
  beginGoalPrompt(sessionFile: string, objective: string, message: string, images?: unknown[], streamingBehavior?: string): Promise<import("./lib/durable-goal").GoalBeginResult>;
  /** Run a `/design …` control invocation; returns the fresh design state. */
  designControl(sessionFile: string, args: string): Promise<import("../electron/design-mode/store").DesignStatus>;
  /** Transactional design start + first interview turn for an addressed session. */
  beginDesignPrompt(sessionFile: string, subject: string, message: string, images?: unknown[], streamingBehavior?: string): Promise<import("../electron/design-mode/store").DesignBeginResult>;
  // Lifecycle
  onTaskUpdate(cb: (tasks: Task[]) => void): () => void;
  onAttentionUpdate(cb: (reg: AttentionRegistry) => void): () => void;
  onAgentEvent(cb: (ev: unknown) => void): () => void;
  onStatus(cb: (s: unknown) => void): () => void;
}
