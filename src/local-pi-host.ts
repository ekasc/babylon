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
import type { DurableGoalState } from "./lib/durable-goal";

/**
 * Exactly the PiHost surface the local runtime calls. PiHost declares
 * `implements LocalPiHost`, so the compiler verifies the real host covers
 * it — and the early-startup stub below must also satisfy it, which keeps
 * the fallback total: adding a call here without stubbing it is a build
 * error instead of a runtime TypeError.
 */
export interface LocalPiHost {
  prompt(message: string, images: PromptImage[] | undefined, streamingBehavior: "steer" | "followUp" | undefined, sessionFile: string): Promise<void>;
  abort(sessionFile: string): Promise<void>;
  getState(sessionFile: string): Promise<AgentState>;
  getMessages(sessionFile: string): Promise<unknown[]>;
  getToolOutput(sessionFile: string, toolCallId: string): Promise<{ content: string; truncated: boolean }>;
  getStats(sessionFile: string): Promise<SessionStats>;
  getCommands(sessionFile: string): Promise<CommandInfo[]>;
  getModels(cwd: string): Promise<AgentModel[]>;
  setModel(sessionFile: string, provider: string, modelId: string): Promise<{ model: unknown }>;
  setThinking(sessionFile: string, level: string): Promise<unknown>;
  getThinkingLevels(sessionFile: string): Promise<string[]>;
  getSettings(): Promise<PiSettings>;
  setSettings(patch: Partial<PiSettings>): Promise<PiSettings>;
  setSessionName(sessionFile: string, name: string): Promise<unknown>;
  renameSession(sessionFile: string, name: string): Promise<unknown>;
  compact(sessionFile: string, customInstructions?: string): Promise<unknown>;
  getTree(sessionFile: string): Promise<{ rows: SessionTreeRow[]; leafId: string | null }>;
  getHistory(sessionFile: string): Promise<HistoryProjection>;
  getTurnChanges(sessionFile: string, entryId: string): Promise<TurnChanges>;
  getTurnFileDiff(sessionFile: string, entryId: string, path: string): Promise<TurnFileDiff>;
  prepareRollback(sessionFile: string, entryId: string): Promise<RollbackPlan>;
  commitRollback(planId: string): Promise<{ editorText: string; history: HistoryProjection }>;
  undoRollback(sessionFile: string): Promise<{ history: HistoryProjection }>;
  getForkMessages(sessionFile: string): Promise<{ entryId: string; text: string }[]>;
  fork(sessionFile: string, entryId: string): Promise<{ text?: string; cancelled?: boolean }>;
  clone(sessionFile: string): Promise<{ cancelled?: boolean; sessionFile?: string }>;
  generateGitCommitMessage(context: PreparedCommitContext): Promise<GeneratedCommitMessage>;
  getRecaps(sessionFile: string): Promise<Recap[]>;
  refreshFromDisk(sessionPath: string): Promise<boolean>;
  respondUi(id: string, resp: unknown): void;
  controlThread(action: "steer" | "follow-up" | "stop", threadId: string, message?: string): Promise<unknown>;
  promoteThread(threadId: string): Promise<{ sessionFile: string; cwd: string; parentSessionFile: string | null }>;
  controlSubagent(action: SubagentControlAction, runId: string, message?: string): Promise<unknown>;
  promoteSubagent(runId: string): Promise<{ sessionFile: string; cwd: string; parentSessionFile: string | null }>;
  warmProject(cwd: string): { warmed: boolean };
  hasSessionRuntime(sessionFile: string): boolean;
  sessionCwdFor(sessionFile: string): string | null;
  listProjectExecutions(): Promise<import("./execution").ProjectExecution[]>;
  /** Run a `/goal …` control invocation without opening a turn; returns the fresh durable goal. */
  execGoalCommand(sessionFile: string, args: string): Promise<DurableGoalState | null>;
  executionSnapshot(cwd: string): Promise<import("./execution").ProjectExecution | null>;
  activateExecution(cwd: string, sessionFile?: string, opts?: { systemPrompt?: string | null }): Promise<import("../electron/pi-host").SessionEntry>;
  relocateExecution(sessionFile: string, fromCwd: string, toCwd: string): Promise<import("../electron/pi-host").SessionEntry>;
  deactivateExecution(cwd: string, expectedSessionFile: string): Promise<boolean>;
  /** Silently persist a goal objective for an addressed session (no follow-up turn). */
  beginGoalPrompt(sessionFile: string, objective: string, message: string, images?: PromptImage[], streamingBehavior?: "steer" | "followUp"): Promise<import("./lib/durable-goal").GoalBeginResult>;
  /** Run a `/design …` control invocation; returns the fresh design state. */
  execDesignCommand(sessionFile: string, args: string): Promise<import("../electron/design-mode/store").DesignStatus>;
  /** Transactional design start + first interview turn for an addressed session. */
  beginDesignPrompt(sessionFile: string, subject: string, message: string, images?: PromptImage[], streamingBehavior?: "steer" | "followUp"): Promise<import("../electron/design-mode/store").DesignBeginResult>;
}

