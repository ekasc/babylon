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
  readonly activeSessionFile: string | null;
  open(opts: { path?: string; cwd: string; requestId?: number; systemPrompt?: string | null }): Promise<AgentState>;
  prompt(message: string, images?: PromptImage[], streamingBehavior?: "steer" | "followUp", sessionFile?: string | null): Promise<void>;
  abort(sessionFile?: string | null): Promise<void>;
  getState(): Promise<AgentState>;
  getMessages(): Promise<unknown[]>;
  getToolOutput(toolCallId: string): Promise<{ content: string; truncated: boolean }>;
  getStats(): Promise<SessionStats>;
  getCommands(): Promise<CommandInfo[]>;
  getModels(): Promise<AgentModel[]>;
  setModel(provider: string, modelId: string): Promise<{ model: unknown }>;
  setThinking(level: string): Promise<unknown>;
  getThinkingLevels(): Promise<string[]>;
  getSettings(): Promise<PiSettings>;
  setSettings(patch: Partial<PiSettings>): Promise<PiSettings>;
  setSessionName(name: string): Promise<unknown>;
  compact(customInstructions?: string): Promise<unknown>;
  getTree(): Promise<{ rows: SessionTreeRow[]; leafId: string | null }>;
  getHistory(): Promise<HistoryProjection>;
  getTurnChanges(entryId: string): Promise<TurnChanges>;
  getTurnFileDiff(entryId: string, path: string): Promise<TurnFileDiff>;
  prepareRollback(entryId: string): Promise<RollbackPlan>;
  commitRollback(planId: string): Promise<{ editorText: string; history: HistoryProjection }>;
  undoRollback(): Promise<{ history: HistoryProjection }>;
  getForkMessages(): Promise<{ entryId: string; text: string }[]>;
  fork(entryId: string): Promise<{ text?: string; cancelled?: boolean }>;
  clone(): Promise<{ cancelled?: boolean }>;
  generateGitCommitMessage(context: PreparedCommitContext): Promise<GeneratedCommitMessage>;
  getRecaps(sessionFile: string): Promise<Recap[]>;
  refreshFromDisk(sessionPath: string): Promise<boolean>;
  switchTo(sessionPath: string, options?: { cwdOverride?: string }): Promise<AgentState>;
  respondUi(id: string, resp: unknown): void;
  controlThread(action: "steer" | "follow-up" | "stop", threadId: string, message?: string): Promise<unknown>;
  promoteThread(threadId: string): Promise<{ sessionFile: string; cwd: string; parentSessionFile: string | null }>;
  controlSubagent(action: SubagentControlAction, runId: string, message?: string): Promise<unknown>;
  promoteSubagent(runId: string): Promise<{ sessionFile: string; cwd: string; parentSessionFile: string | null }>;
  warmProject(cwd: string): { warmed: boolean };
  releaseSession(sessionFile: string): Promise<boolean>;
  /** Run a `/goal …` control invocation without opening a turn; returns the fresh durable goal. */
  execGoalCommand(args: string): Promise<DurableGoalState | null>;
  /** Run a `/design …` control invocation; returns the fresh design state. */
  execDesignCommand(args: string): Promise<import("../electron/design-mode/store").DesignStatus>;
}

