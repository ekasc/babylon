export interface SessionMeta {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  startedAt?: string;
  mtime: number;
  size?: number;
  firstUserText?: string;
  isWorktree?: boolean;
  parentPath?: string;
}

export interface ProjectGroup {
  cwd: string;
  sessions: SessionMeta[];
}

export interface CommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  source: "extension" | "prompt" | "skill";
}

export interface SessionsUpdate {
  groups: ProjectGroup[];
  changedPaths: string[];
  version: number;
  source?: "filesystem" | "host";
}

export interface SessionStatus {
  status: "idle" | "starting" | "ready" | "exited" | "error";
  cwd?: string;
  message?: string;
  state?: any;
  sessionPath?: string;
  requestId?: number;
  code?: number;
}

export interface ThreadActivity {
  threadId: string;
  name: string | null;
  goal: string;
  status: string;
  cwd?: string;
  parentSessionFile?: string | null;
  mode: string;
  profile: string;
  model: string;
  parentSessionId: string;
  sessionFile: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  latestSummary: string | null;
  latestActivity: string | null;
  filesChanged: string[];
  commandsRun: string[];
  testsRun: string[];
  blocker: string | null;
  failureReason: string | null;
  milestones?: Array<{ at: string; name: string; note?: string }>;
  recentMessages?: Array<{ at: string; role: string; text: string }>;
  revision?: number;
}

export interface SubagentActivity {
  runId: string;
  status: "starting" | "running" | "idle" | "failed" | "stopped" | "interrupted" | "completed" | "routing_mismatch" | "unknown";
  requestedModel?: string;
  sessionModel?: string;
  payloadModel?: string;
  matched?: boolean;
  startedAt?: string;
  updatedAt: string;
  output?: string;
  stderr?: string;
  controllable?: boolean;
  name?: string | null;
  task?: string;
  profile?: string;
  thinking?: string;
  sessionFile?: string | null;
  parentSessionId?: string | null;
  parentSessionFile?: string | null;
  latestActivity?: string | null;
  persistent?: boolean;
  goal?: string | null;
  milestones?: Array<{ at: string; name: string; note?: string }>;
  recentMessages?: Array<{ at: string; role: string; text: string }>;
  revision?: number;
}

export interface ActivityUpdate {
  threads: ThreadActivity[];
  subagents: SubagentActivity[];
}

/* -------------------------------------------------------------------------
   Workflows (pi-dynamic-workflows extension) — run state contract.
   Runs persist as JSON files at <project cwd>/.pi/workflows/runs/*.json
   (PersistedRunState). The Electron bridge (electron/workflows.ts) polls that
   dir and exposes summaries/details over IPC; these types mirror the on-disk
   schema so the renderer never imports the extension package.
------------------------------------------------------------------------- */

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "aborted";

export type WorkflowAgentStatus =
  | "queued"
  | "running"
  | "retrying"
  | "done"
  | "error"
  | "skipped";

export type WorkflowControlAction = "pause" | "resume" | "stop" | "retry";

export interface WorkflowTokenUsage {
  input: number;
  output: number;
  total: number;
  cost?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface WorkflowAgentSummary {
  id: number;
  label: string;
  status: string;
  phase?: string;
}

export interface WorkflowRunSummary {
  runId: string;
  workflowName: string;
  description?: string;
  status: WorkflowRunStatus;
  /** Owning pi session — absent for legacy/global runs (read-only in GUI). */
  sessionId?: string;
  phases: string[];
  currentPhase?: string;
  agents?: WorkflowAgentSummary[];
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: WorkflowTokenUsage;
}

export interface WorkflowHistoryEntry {
  role: "user" | "assistant" | "tool";
  kind: "text" | "toolCall" | "toolResult" | "error";
  text: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}

export interface WorkflowAgentDetail extends WorkflowAgentSummary {
  /** Real run files persist the agent-options object ({ label, phase, tier, prompt }) —
      treat as opaque; extract the instruction text for display. */
  prompt?: unknown;
  result?: unknown;
  /** Readable markdown summary of the result, when the raw result is structured. */
  resultPreview?: string;
  error?: string;
  errorCode?: string;
  recoverable?: boolean;
  history?: WorkflowHistoryEntry[];
  queuedAt?: string;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  attempt?: number;
  maxAttempts?: number;
  waitReason?: string;
  tokens?: number;
  tokenUsage?: WorkflowTokenUsage;
  model?: string;
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  script?: string;
  agents?: WorkflowAgentDetail[];
  logs?: string[];
  result?: unknown;
  error?: string;
  errorCode?: string;
  pauseReason?: string;
  resetHint?: string;
}

export interface WorkflowUpdatePayload {
  runs: WorkflowRunSummary[];
}

export interface HistoryTurn {
  entryId: string;
  parentUserEntryId: string | null;
  index: number;
  depth: number;
  text: string;
  response: string;
  onActivePath: boolean;
  current: boolean;
  branchCount: number;
  checkpointAvailable: boolean;
  rollbackAvailable: boolean;
  rollbackReason?: string;
}

export interface HistoryProjection {
  turns: HistoryTurn[];
  leafId: string | null;
  hasBranches: boolean;
  activeRollback?: {
    targetUserEntryId: string;
    abandonedCount: number;
    fileCount: number;
    editorText: string;
    createdAt: string;
    undoAvailable: boolean;
    undoReason?: string;
  };
}

export interface RollbackPlan {
  planId: string;
  targetUserEntryId: string;
  targetText: string;
  abandonedCount: number;
  changes: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
  counts: { added: number; modified: number; deleted: number };
  expiresAt: string;
}

export interface SessionTreeRow {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
  snippet: string;
  label?: string;
  depth: number;
  childCount: number;
}

export interface SessionWindow {
  messages: any[];
  /** Byte offset of the first message in the window (for older windows). */
  startOffset: number;
}

export interface Bridge {
  listSessions(): Promise<ProjectGroup[]>;
  getSessionMessages(path: string): Promise<SessionWindow>;
  getSessionWindow(path: string, endOffset: number, countBytes?: number): Promise<SessionWindow>;
  getToolOutput(toolCallId: string): Promise<{ content: string; truncated: boolean }>;
  deleteSession(path: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  openSession(opts: { path?: string; cwd: string; requestId?: number }): Promise<void>;

  prompt(message: string, images?: any[], streamingBehavior?: "steer" | "followUp"): Promise<any>;
  abort(): Promise<any>;
  refreshSession(path: string): Promise<boolean>;

  getMessages(): Promise<any[]>;
  getState(): Promise<any>;
  getStats(): Promise<any>;
  getModels(): Promise<any[]>;
  getCommands(): Promise<CommandInfo[]>;
  setModel(provider: string, modelId: string): Promise<any>;
  setThinking(level: string): Promise<any>;
  getThinkingLevels(): Promise<string[]>;
  setSessionName(name: string): Promise<any>;
  compact(): Promise<any>;

  getTree(): Promise<{ rows: SessionTreeRow[]; leafId: string | null }>;
  getHistory(): Promise<HistoryProjection>;
  prepareRollback(entryId: string): Promise<RollbackPlan>;
  commitRollback(planId: string): Promise<{ editorText: string; history: HistoryProjection }>;
  undoRollback(): Promise<{ history: HistoryProjection }>;
  getForkMessages(): Promise<{ entryId: string; text: string }[]>;
  fork(entryId: string): Promise<{ text?: string; cancelled?: boolean }>;
  clone(): Promise<{ cancelled?: boolean }>;

  worktreeInfo(): Promise<{
    isWorktree: boolean;
    sessionFile?: string;
    parentSession?: string;
    cwd?: string;
    git: { isRepo: boolean; root?: string; branch?: string; isLinkedWorktree?: boolean };
  }>;
  worktreeCreate(opts: { name: string; description?: string; useGit?: boolean }): Promise<{
    worktreePath: string;
    originalPath: string;
    gitWorktree?: { path: string; branch: string; baseBranch?: string } | null;
  }>;
  worktreeExit(opts: { keep: boolean }): Promise<{
    originalPath: string;
    kept: boolean;
    gitRemoved: boolean;
  }>;

  uiRespond(resp: Record<string, unknown>): Promise<void>;
  openExternal(url: string): Promise<void>;

  activityList(): Promise<ActivityUpdate>;
  threadsControl(action: "steer" | "follow-up" | "stop", threadId: string, message?: string): Promise<ThreadActivity>;
  threadsPromote(threadId: string): Promise<{ sessionFile: string; cwd: string; parentSessionFile: string | null }>;
  subagentsControl(action: "steer" | "follow-up" | "stop", runId: string, message?: string): Promise<SubagentActivity>;
  subagentsPromote(runId: string): Promise<{ sessionFile: string; cwd: string; parentSessionFile: string | null }>;
  onActivityUpdate(cb: (payload: ActivityUpdate) => void): () => void;

  workflowsList(): Promise<WorkflowRunSummary[]>;
  workflowsGet(runId: string): Promise<WorkflowRunDetail | null>;
  workflowsDelete(runId: string): Promise<boolean>;
  workflowsControl(action: WorkflowControlAction, runId: string): Promise<void>;
  /** Fires whenever the workflows bridge detects changed run state. */
  onSessionsUpdate(cb: (payload: SessionsUpdate) => void): () => void;
  onWorkflowsUpdate(cb: (payload: WorkflowUpdatePayload) => void): () => void;

  onAgentEvents(cb: (events: any[]) => void): () => void;
  onAgentEvent(cb: (event: any) => void): () => void;
  onStatus(cb: (status: SessionStatus) => void): () => void;
}

declare global {
  interface Window {
    pideck?: Bridge;
  }
}

/**
 * Fail-safe bridge access. If the preload script failed to load (or the
 * renderer is opened outside Electron), `window.pideck` is undefined and the
 * old `export const bridge = window.pideck` made every effect call throw —
 * React then unmounted the whole tree and the window went completely blank
 * (#161616, no UI, no error). Instead we surface the condition explicitly
 * (`bridgeAvailable`) and fall back to a no-op stub so the app can render a
 * visible, actionable error screen.
 */
export const bridgeAvailable: boolean = !!window.pideck;

export const bridge: Bridge = window.pideck ?? {
  listSessions: () => Promise.resolve([]),
  getSessionMessages: () => Promise.resolve({ messages: [], startOffset: 0 }),
  getSessionWindow: () => Promise.resolve({ messages: [], startOffset: 0 }),
  getToolOutput: () => Promise.reject(new Error("bridge unavailable")),
  deleteSession: () => Promise.reject(new Error("bridge unavailable")),
  pickFolder: () => Promise.resolve(null),
  openSession: () => Promise.resolve(),

  prompt: () => Promise.resolve(),
  abort: () => Promise.resolve(),
  refreshSession: () => Promise.resolve(false),

  getMessages: () => Promise.resolve([]),
  getState: () => Promise.resolve(null),
  getStats: () => Promise.resolve(null),
  getModels: () => Promise.resolve([]),
  getCommands: () => Promise.resolve([]),
  setModel: () => Promise.resolve(),
  setThinking: () => Promise.resolve(),
  getThinkingLevels: () => Promise.resolve([]),
  setSessionName: () => Promise.resolve(),
  compact: () => Promise.resolve(),

  getTree: () => Promise.resolve({ rows: [], leafId: null }),
  getHistory: () => Promise.resolve({ turns: [], leafId: null, hasBranches: false }),
  prepareRollback: () => Promise.reject(new Error("bridge unavailable")),
  commitRollback: () => Promise.reject(new Error("bridge unavailable")),
  undoRollback: () => Promise.reject(new Error("bridge unavailable")),
  getForkMessages: () => Promise.resolve([]),
  fork: () => Promise.resolve({ cancelled: true }),
  clone: () => Promise.resolve({ cancelled: true }),
  worktreeInfo: () =>
    Promise.resolve({
      isWorktree: false,
      git: { isRepo: false },
    }),
  worktreeCreate: () => Promise.reject(new Error("bridge unavailable")),
  worktreeExit: () => Promise.reject(new Error("bridge unavailable")),

  uiRespond: () => Promise.resolve(),
  openExternal: () => Promise.resolve(),

  activityList: () => Promise.resolve({ threads: [], subagents: [] }),
  threadsControl: () => Promise.reject(new Error("bridge unavailable")),
  threadsPromote: () => Promise.reject(new Error("bridge unavailable")),
  subagentsControl: () => Promise.reject(new Error("bridge unavailable")),
  subagentsPromote: () => Promise.reject(new Error("bridge unavailable")),
  onActivityUpdate: () => () => {},

  workflowsList: () => Promise.resolve([]),
  workflowsGet: () => Promise.resolve(null),
  workflowsDelete: () => Promise.resolve(false),
  workflowsControl: () => Promise.resolve(),
  onSessionsUpdate: () => () => {},
  onWorkflowsUpdate: () => () => {},

  onAgentEvents: () => () => {},
  onAgentEvent: () => () => {},
  onStatus: () => () => {},
};
