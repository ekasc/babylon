import type { Task } from "./tasks";

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

export interface GitFileChange {
  path: string;
  status: string;
}

export interface GitStatusResult {
  isRepo: boolean;
  root?: string;
  branch?: string;
  isWorktree?: boolean;
  dirty: GitFileChange[];
  ahead: number;
  behind: number;
}

export interface GitChangedFile {
  path: string;
  insertions: number;
  deletions: number;
  /** Porcelain change kind: A | M | D | R | C | T | U | ?. */
  status?: string;
}

export interface GitStatusDetails {
  isRepo: boolean;
  root?: string;
  branch: string | null;
  upstreamRef: string | null;
  hasUpstream: boolean;
  defaultBranch: string | null;
  isDefaultBranch: boolean;
  hasOriginRemote: boolean;
  isLinkedWorktree: boolean;
  ahead: number;
  behind: number;
  aheadOfDefault: number;
  hasChanges: boolean;
  files: GitChangedFile[];
  insertions: number;
  deletions: number;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  committedAt: number;
}

export type GitCommitPushPhase = "preparing" | "generating" | "committing" | "pushing" | "done" | "error";

export interface GitCommitPushProgress {
  requestId: string;
  phase: GitCommitPushPhase;
  message: string;
}

export interface GitCommitPushResult {
  generated: { subject: string; body: string; message: string };
  commit: { commitSha: string; subject: string };
  push: { status: "pushed" | "skipped_up_to_date"; branch: string; upstreamBranch?: string };
}

export interface GitPrSummary {
  number: number;
  title: string;
  url: string;
  baseRef: string;
  headRef: string;
  state: "open" | "closed" | "merged";
}

export interface GitPrContext {
  provider: "github" | "gitlab" | "unknown";
  tool: { command: "gh" | "glab"; installed: boolean; authenticated: boolean } | null;
  openPr: GitPrSummary | null;
}

export interface GitPrCreateResult {
  status: "created" | "opened_existing";
  number?: number;
  url?: string;
  title: string;
  baseBranch: string;
  headBranch: string;
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
  changedCount: number;
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

export interface TurnFileChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

export interface TurnChanges {
  userEntryId: string;
  files: TurnFileChange[];
  totals: { files: number; additions: number; deletions: number };
  exclusions: string[];
}

export interface TurnFileDiff {
  diff: string;
  truncated: boolean;
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

export type PermissionMode = "supervised" | "auto" | "full_access";
export type PolicyCategory =
  | "file_read"
  | "file_write_workspace"
  | "file_write_outside"
  | "shell_command"
  | "shell_destructive"
  | "network_access"
  | "git_commit"
  | "git_push"
  | "package_install"
  | "process_spawn"
  | "privileged";
export type Risk = "low" | "high" | "uncertain";
export type ApprovalChoice = "allow_once" | "allow_session" | "allow_always" | "deny";

export interface PermissionRule {
  id: string;
  category: PolicyCategory;
  match?: { pathGlob?: string; commandPattern?: string };
  decision: "allow" | "deny";
  scope: "always" | "session";
  createdAt: number;
  note?: string;
}

export interface AgentActionSummary {
  category: PolicyCategory;
  paths?: string[];
  command?: string;
  description?: string;
  repoDirty?: boolean;
}

export interface ApprovalRequest {
  id: string;
  action: AgentActionSummary;
  risk: Risk;
}

export interface PermissionState {
  mode: PermissionMode;
  rules: PermissionRule[];
}

/** Reference to a catalogue model, persisted in Babylon-owned settings. */
export interface ModelRef {
  provider: string;
  modelId: string;
}

/** Babylon-owned user preferences (Settings → Pi). Mirrors the host's
 *  `PiSettings` in electron/app-settings.ts. */
export type ProcessState = "starting" | "running" | "exited" | "failed" | "killed";

export interface ProcessSnapshot {
  id: string;
  command: string;
  cwd: string;
  owner?: string;
  ownerSession?: string;
  pid?: number;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
  state: ProcessState;
  detectedPorts: number[];
  output: string;
  outputTruncated: boolean;
}

export interface PiSettings {
  chatModel?: ModelRef;
  chatReasoning?: string;
  titleModel?: ModelRef;
  titleReasoning?: string;
  gitCommitModel?: ModelRef;
  gitCommitPrompt?: string;
  contextWindowOverrides?: Record<string, number>;
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
  gitStatus(cwd: string): Promise<GitStatusResult | null>;
  gitStatusDetails(cwd: string): Promise<GitStatusDetails>;
  /** Unified diff of one file's working-tree changes vs HEAD (untracked files diff as all-added). */
  gitDiffFile(cwd: string, file: string): Promise<string>;
  gitBranches(cwd: string): Promise<{ branches: GitBranchInfo[]; current: string | null }>;
  gitBranchCreate(cwd: string, name: string, switchTo: boolean): Promise<{ branch: string }>;
  gitBranchSwitch(cwd: string, name: string, options?: { stash?: boolean }): Promise<{ branch: string | null; stashed?: boolean }>;
  gitCommitPush(cwd: string, requestId: string): Promise<GitCommitPushResult>;
  onGitCommitPushProgress(cb: (progress: GitCommitPushProgress) => void): () => void;
  gitCommit(cwd: string, message: string): Promise<{ commitSha: string; subject: string }>;
  gitPush(cwd: string): Promise<{ status: "pushed" | "skipped_up_to_date"; branch: string; upstreamBranch?: string }>;
  gitPull(cwd: string): Promise<{ status: "pulled" | "skipped_up_to_date"; branch: string; upstreamRef: string | null }>;
  gitPrContext(cwd: string): Promise<GitPrContext>;
  gitPrSuggest(cwd: string): Promise<{ title: string; body: string; baseBranch: string; headBranch: string }>;
  gitPrCreate(cwd: string, input: { title: string; body?: string }): Promise<GitPrCreateResult>;
  getModels(): Promise<any[]>;
  getCommands(): Promise<CommandInfo[]>;
  setModel(provider: string, modelId: string): Promise<any>;
  setThinking(level: string): Promise<any>;
  getThinkingLevels(): Promise<string[]>;
  setSessionName(name: string): Promise<any>;
  compact(): Promise<any>;

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

  taskList(): Promise<Task[]>;
  taskGet(id: string): Promise<Task | null>;
  taskSpawn(taskId: string, command: string, cwd: string): Promise<ProcessSnapshot>;
  onTaskUpdate(cb: (tasks: Task[]) => void): () => void;
  worktreeInfo(): Promise<{
    isWorktree: boolean;
    sessionFile?: string;
    parentSession?: string;
    cwd?: string;
    task?: Task;
    git: { isRepo: boolean; root?: string; branch?: string; isLinkedWorktree?: boolean };
  }>;
  worktreeCreate(opts: { name: string; description?: string; useGit?: boolean }): Promise<{
    task: Task;
    taskId: string;
    worktreePath: string;
    originalPath: string;
    gitWorktree?: { path: string; branch: string; baseBranch?: string } | null;
  }>;
  worktreeExit(opts: { keep: boolean }): Promise<{
    originalPath: string;
    kept: boolean;
    gitRemoved: boolean;
    task?: Task;
    removed?: boolean;
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

  permissionsGet(): Promise<PermissionState>;
  getSettings(): Promise<PiSettings>;
  setSettings(patch: Partial<PiSettings>): Promise<PiSettings>;
  permissionsSetMode(mode: PermissionMode): Promise<{ mode: PermissionMode }>;
  permissionsAddRule(
    input: Omit<PermissionRule, "id" | "createdAt"> & Partial<Pick<PermissionRule, "id" | "createdAt">>
  ): Promise<PermissionRule>;
  permissionsRemoveRule(id: string): Promise<{ removed: boolean }>;
  permissionsResolveApproval(id: string, choice: ApprovalChoice): Promise<{ ok: boolean }>;
  onApprovalRequested(cb: (req: ApprovalRequest) => void): () => void;
  /** Fires when a pending approval is released without a user decision
   *  (e.g. Full Access mode was enabled while the agent waited). */
  onApprovalCleared(cb: (payload: { id: string }) => void): () => void;
  /** Fires when an interactive approval is resolved (allowed/denied), so the
   *  UI can drop the matching attention item. */
   onApprovalResolved(cb: (payload: { id: string; choice: ApprovalChoice }) => void): () => void;
  onPermissionsChanged(cb: (state: PermissionState) => void): () => void;

  lspGetSnapshot(cwd: string): Promise<LspProjectSnapshot | null>;
  lspListSnapshots(): Promise<LspProjectSnapshot[]>;
  lspSetProject(cwd: string | null): Promise<LspProjectSnapshot | null>;
  lspRefresh(cwd: string): Promise<LspProjectSnapshot>;
  onLspUpdate(cb: (snapshots: LspProjectSnapshot[]) => void): () => void;

  processList(): Promise<ProcessSnapshot[]>;
  processSpawn(opts: { command: string; cwd: string; owner?: string; ownerSession?: string }): Promise<ProcessSnapshot>;
  processKill(id: string): Promise<ProcessSnapshot>;
  onProcessUpdate(cb: (snapshots: ProcessSnapshot[]) => void): () => void;
}

export type LspServerStatus = "unavailable" | "starting" | "running" | "crashed" | "stopped";
export interface LspDiagnostic {
  file: string;
  line: number;
  character: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  code?: number | string;
}
export interface LspServerSnapshot {
  language: string;
  command: string;
  args: string[];
  pid?: number;
  status: LspServerStatus;
  message?: string;
  restartCount: number;
  diagnostics: LspDiagnostic[];
}
export interface LspProjectSnapshot {
  cwd: string;
  updatedAt: number;
  diagnostics: LspDiagnostic[];
  servers: LspServerSnapshot[];
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
  gitStatus: () => Promise.resolve(null),
  gitStatusDetails: () => Promise.resolve({ isRepo: false } as GitStatusDetails),
  gitDiffFile: () => Promise.reject(new Error("bridge unavailable")),
  gitBranches: () => Promise.resolve({ branches: [], current: null }),
  gitBranchCreate: () => Promise.reject(new Error("bridge unavailable")),
  gitBranchSwitch: () => Promise.reject(new Error("bridge unavailable")),
  gitCommitPush: () => Promise.reject(new Error("bridge unavailable")),
  onGitCommitPushProgress: () => () => undefined,
  gitCommit: () => Promise.reject(new Error("bridge unavailable")),
  gitPush: () => Promise.reject(new Error("bridge unavailable")),
  gitPull: () => Promise.reject(new Error("bridge unavailable")),
  gitPrContext: () => Promise.resolve({ provider: "unknown", tool: null, openPr: null }),
  gitPrSuggest: () => Promise.reject(new Error("bridge unavailable")),
  gitPrCreate: () => Promise.reject(new Error("bridge unavailable")),
  getModels: () => Promise.resolve([]),
  getCommands: () => Promise.resolve([]),
  setModel: () => Promise.resolve(),
  setThinking: () => Promise.resolve(),
  getThinkingLevels: () => Promise.resolve([]),
  setSessionName: () => Promise.resolve(),
  compact: () => Promise.resolve(),

  getTree: () => Promise.resolve({ rows: [], leafId: null }),
  getHistory: () => Promise.resolve({ turns: [], leafId: null, hasBranches: false }),
  getTurnChanges: () => Promise.reject(new Error("bridge unavailable")),
  getTurnFileDiff: () => Promise.reject(new Error("bridge unavailable")),
  prepareRollback: () => Promise.reject(new Error("bridge unavailable")),
  commitRollback: () => Promise.reject(new Error("bridge unavailable")),
  undoRollback: () => Promise.reject(new Error("bridge unavailable")),
  getForkMessages: () => Promise.resolve([]),
  fork: () => Promise.resolve({ cancelled: true }),
  clone: () => Promise.resolve({ cancelled: true }),
  taskList: () => Promise.resolve([]),
  taskGet: () => Promise.resolve(null),
  taskSpawn: () => Promise.reject(new Error("bridge unavailable")),
  onTaskUpdate: () => () => {},
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

  permissionsGet: () => Promise.resolve({ mode: "auto", rules: [] }),
  getSettings: () => Promise.resolve({}),
  setSettings: () => Promise.resolve({}),
  permissionsSetMode: () => Promise.resolve({ mode: "auto" }),
  permissionsAddRule: () => Promise.reject(new Error("bridge unavailable")),
  permissionsRemoveRule: () => Promise.resolve({ removed: false }),
  permissionsResolveApproval: () => Promise.resolve({ ok: false }),
  onApprovalRequested: () => () => {},
  onApprovalCleared: () => () => {},
  onApprovalResolved: () => () => {},
  onPermissionsChanged: () => () => {},

  lspGetSnapshot: () => Promise.resolve(null),
  lspListSnapshots: () => Promise.resolve([]),
  lspSetProject: () => Promise.resolve(null),
  lspRefresh: () => Promise.reject(new Error("bridge unavailable")),
  onLspUpdate: () => () => {},

  processList: () => Promise.resolve([]),
  processSpawn: () => Promise.reject(new Error("bridge unavailable")),
  processKill: () => Promise.reject(new Error("bridge unavailable")),
  onProcessUpdate: () => () => {},
};
