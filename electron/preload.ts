import { contextBridge, ipcRenderer } from "electron";

const api = {
  listSessions: (): Promise<any> => ipcRenderer.invoke("pideck:list-sessions"),
  getSessionMessages: (path: string): Promise<{ messages: any[]; startOffset: number }> =>
    ipcRenderer.invoke("pideck:get-session-messages", path),
  getSessionWindow: (path: string, endOffset: number, countBytes?: number): Promise<{ messages: any[]; startOffset: number }> =>
    ipcRenderer.invoke("pideck:get-session-window", path, endOffset, countBytes),
  getToolOutput: (toolCallId: string): Promise<{ content: string; truncated: boolean }> =>
    ipcRenderer.invoke("pideck:get-tool-output", toolCallId),
  deleteSession: (path: string): Promise<void> => ipcRenderer.invoke("pideck:delete-session", path),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("pideck:pick-folder"),
  openSession: (opts: { path?: string; cwd: string; requestId?: number }): Promise<void> =>
    ipcRenderer.invoke("pideck:open-session", opts),

  prompt: (message: string, images?: any[], streamingBehavior?: "steer" | "followUp"): Promise<any> =>
    ipcRenderer.invoke("pideck:prompt", message, images, streamingBehavior),
  abort: (): Promise<any> => ipcRenderer.invoke("pideck:abort"),
  refreshSession: (path: string): Promise<boolean> => ipcRenderer.invoke("pideck:refresh-session", path),

  getMessages: (): Promise<any[]> => ipcRenderer.invoke("pideck:get-messages"),
  getState: (): Promise<any> => ipcRenderer.invoke("pideck:get-state"),
  getStats: (): Promise<any> => ipcRenderer.invoke("pideck:get-stats"),
  gitStatus: (cwd: string): Promise<any> => ipcRenderer.invoke("pideck:git-status", cwd),
  gitStatusDetails: (cwd: string): Promise<any> => ipcRenderer.invoke("pideck:git-status-details", cwd),
  gitDiffFile: (cwd: string, file: string): Promise<string> => ipcRenderer.invoke("pideck:git-diff-file", cwd, file),
  gitBranches: (cwd: string): Promise<any> => ipcRenderer.invoke("pideck:git-branches", cwd),
  gitBranchCreate: (cwd: string, name: string, switchTo: boolean): Promise<any> =>
    ipcRenderer.invoke("pideck:git-branch-create", cwd, name, switchTo),
  gitBranchSwitch: (cwd: string, name: string, options?: { stash?: boolean }): Promise<any> =>
    ipcRenderer.invoke("pideck:git-branch-switch", cwd, name, options),
  gitCommitPush: (cwd: string, requestId: string): Promise<any> => ipcRenderer.invoke("pideck:git-commit-push", cwd, requestId),
  onGitCommitPushProgress: (cb: (progress: any) => void): (() => void) => {
    const listener = (_e: unknown, progress: any) => cb(progress);
    ipcRenderer.on("pideck:git-commit-push-progress", listener);
    return () => ipcRenderer.removeListener("pideck:git-commit-push-progress", listener);
  },
  gitCommit: (cwd: string, message: string): Promise<any> => ipcRenderer.invoke("pideck:git-commit", cwd, message),
  gitPush: (cwd: string): Promise<any> => ipcRenderer.invoke("pideck:git-push", cwd),
  gitPull: (cwd: string): Promise<any> => ipcRenderer.invoke("pideck:git-pull", cwd),
  gitPrContext: (cwd: string): Promise<any> => ipcRenderer.invoke("pideck:git-pr-context", cwd),
  gitPrSuggest: (cwd: string): Promise<any> => ipcRenderer.invoke("pideck:git-pr-suggest", cwd),
  gitPrCreate: (cwd: string, input: { title: string; body?: string }): Promise<any> =>
    ipcRenderer.invoke("pideck:git-pr-create", cwd, input),
  getModels: (): Promise<any[]> => ipcRenderer.invoke("pideck:get-models"),
  getCommands: (): Promise<any[]> => ipcRenderer.invoke("pideck:get-commands"),
  setModel: (provider: string, modelId: string): Promise<any> =>
    ipcRenderer.invoke("pideck:set-model", provider, modelId),
  setThinking: (level: string): Promise<any> => ipcRenderer.invoke("pideck:set-thinking", level),
  getThinkingLevels: (): Promise<string[]> => ipcRenderer.invoke("pideck:get-thinking-levels"),
  setSessionName: (name: string): Promise<any> => ipcRenderer.invoke("pideck:set-session-name", name),
  compact: (): Promise<any> => ipcRenderer.invoke("pideck:compact"),
  getSettings: (): Promise<any> => ipcRenderer.invoke("pideck:get-settings"),
  setSettings: (patch: any): Promise<any> => ipcRenderer.invoke("pideck:set-settings", patch),

  // Branching / worktrees
  getTree: (): Promise<any> => ipcRenderer.invoke("pideck:get-tree"),
  getHistory: (): Promise<any> => ipcRenderer.invoke("pideck:get-history"),
  getTurnChanges: (entryId: string): Promise<any> => ipcRenderer.invoke("pideck:turn-changes", entryId),
  getTurnFileDiff: (entryId: string, path: string): Promise<any> =>
    ipcRenderer.invoke("pideck:turn-file-diff", entryId, path),
  prepareRollback: (entryId: string): Promise<any> => ipcRenderer.invoke("pideck:rollback:prepare", entryId),
  commitRollback: (planId: string): Promise<any> => ipcRenderer.invoke("pideck:rollback:commit", planId),
  undoRollback: (): Promise<any> => ipcRenderer.invoke("pideck:rollback:undo"),
  getForkMessages: (): Promise<any[]> => ipcRenderer.invoke("pideck:get-fork-messages"),
  fork: (entryId: string): Promise<any> => ipcRenderer.invoke("pideck:fork", entryId),
  clone: (): Promise<any> => ipcRenderer.invoke("pideck:clone"),
  taskList: (): Promise<any[]> => ipcRenderer.invoke("pideck:task-list"),
  taskGet: (id: string): Promise<any> => ipcRenderer.invoke("pideck:task-get", id),
  taskSpawn: (taskId: string, command: string, cwd: string): Promise<any> =>
    ipcRenderer.invoke("pideck:task-spawn", taskId, command, cwd),
  taskSetContract: (taskId: string, contract: any): Promise<any> =>
    ipcRenderer.invoke("pideck:task-set-contract", taskId, contract),
  taskComplete: (taskId: string, results: any[]): Promise<any> =>
    ipcRenderer.invoke("pideck:task-complete", taskId, results),
  onTaskUpdate: (cb: (tasks: any[]) => void): (() => void) => {
    const listener = (_e: unknown, tasks: any[]) => cb(tasks);
    ipcRenderer.on("pideck:task-update", listener);
    return () => ipcRenderer.removeListener("pideck:task-update", listener);
  },
  hooksList: (): Promise<any[]> => ipcRenderer.invoke("pideck:hooks-list"),
  hooksRegister: (hook: any): Promise<any[]> => ipcRenderer.invoke("pideck:hooks-register", hook),
  hooksRemove: (id: string): Promise<any[]> => ipcRenderer.invoke("pideck:hooks-remove", id),
  onHooksUpdate: (cb: (hooks: any) => void): (() => void) => {
    const listener = (_e: unknown, hooks: any) => cb(hooks);
    ipcRenderer.on("pideck:hooks-update", listener);
    return () => ipcRenderer.removeListener("pideck:hooks-update", listener);
  },
  contractsList: (): Promise<any[]> => ipcRenderer.invoke("pideck:contracts-list"),
  contractsGet: (id: string): Promise<any> => ipcRenderer.invoke("pideck:contracts-get", id),
  attentionList: (): Promise<any> => ipcRenderer.invoke("pideck:attention-list"),
  attentionResolve: (id: string): Promise<any> => ipcRenderer.invoke("pideck:attention-resolve", id),
  onAttentionUpdate: (cb: (attention: any) => void): (() => void) => {
    const listener = (_e: unknown, attention: any) => cb(attention);
    ipcRenderer.on("pideck:attention-update", listener);
    return () => ipcRenderer.removeListener("pideck:attention-update", listener);
  },
  worktreeInfo: (): Promise<any> => ipcRenderer.invoke("pideck:worktree-info"),
  worktreeCreate: (opts: { name: string; description?: string; useGit?: boolean }): Promise<any> =>
    ipcRenderer.invoke("pideck:worktree-create", opts),
  worktreeExit: (opts: { keep: boolean }): Promise<any> =>
    ipcRenderer.invoke("pideck:worktree-exit", opts),

  uiRespond: (resp: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke("pideck:ui-respond", resp),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("pideck:open-external", url),

  // Threads + subagents activity
  activityList: (): Promise<any> => ipcRenderer.invoke("pideck:activity:list"),
  threadsControl: (action: string, threadId: string, message?: string): Promise<any> =>
    ipcRenderer.invoke("pideck:threads:control", { action, threadId, message }),
  threadsPromote: (threadId: string): Promise<any> => ipcRenderer.invoke("pideck:threads:promote", threadId),
  subagentsControl: (action: string, runId: string, message?: string): Promise<any> =>
    ipcRenderer.invoke("pideck:subagents:control", { action, runId, message }),
  subagentsPromote: (runId: string): Promise<any> =>
    ipcRenderer.invoke("pideck:subagents:promote", runId),
  onActivityUpdate: (cb: (update: any) => void): (() => void) => {
    const listener = (_e: unknown, update: any) => cb(update);
    ipcRenderer.on("pideck:activity-update", listener);
    return () => ipcRenderer.removeListener("pideck:activity-update", listener);
  },

  // Workflows (pi-dynamic-workflows run state)
  workflowsList: (): Promise<any> => ipcRenderer.invoke("pideck:workflows:list"),
  workflowsGet: (runId: string): Promise<any> => ipcRenderer.invoke("pideck:workflows:get", runId),
  workflowsDelete: (runId: string): Promise<any> => ipcRenderer.invoke("pideck:workflows:delete", runId),
  workflowsControl: (action: string, runId: string): Promise<any> =>
    ipcRenderer.invoke("pideck:workflows:control", { action, runId }),
  onSessionsUpdate: (cb: (update: any) => void): (() => void) => {
    const listener = (_e: unknown, update: any) => cb(update);
    ipcRenderer.on("pideck:sessions-update", listener);
    return () => ipcRenderer.removeListener("pideck:sessions-update", listener);
  },
  onWorkflowsUpdate: (cb: (update: any) => void): (() => void) => {
    const listener = (_e: unknown, u: any) => cb(u);
    ipcRenderer.on("pideck:workflows-update", listener);
    return () => ipcRenderer.removeListener("pideck:workflows-update", listener);
  },

  processList: (): Promise<any> => ipcRenderer.invoke("pideck:process-list"),
  processSpawn: (opts: { command: string; cwd: string; owner?: string; ownerSession?: string }): Promise<any> =>
    ipcRenderer.invoke("pideck:process-spawn", opts),
  processKill: (id: string): Promise<any> => ipcRenderer.invoke("pideck:process-kill", id),
  onProcessUpdate: (cb: (snapshots: any[]) => void): (() => void) => {
    const listener = (_e: unknown, snapshots: any[]) => cb(snapshots);
    ipcRenderer.on("pideck:process-update", listener);
    return () => ipcRenderer.removeListener("pideck:process-update", listener);
  },

  onAgentEvents: (cb: (events: any[]) => void): (() => void) => {
    const listener = (_e: unknown, events: any[]) => cb(events);
    ipcRenderer.on("pideck:agent-events", listener);
    return () => ipcRenderer.removeListener("pideck:agent-events", listener);
  },
  onAgentEvent: (cb: (event: any) => void): (() => void) => {
    const listener = (_e: unknown, ev: any) => cb(ev);
    ipcRenderer.on("pideck:agent-event", listener);
    return () => ipcRenderer.removeListener("pideck:agent-event", listener);
  },

  permissionsGet: (): Promise<any> => ipcRenderer.invoke("pideck:permissions:get"),
  permissionsSetMode: (mode: string): Promise<any> => ipcRenderer.invoke("pideck:permissions:set-mode", mode),
  permissionsAddRule: (input: any): Promise<any> => ipcRenderer.invoke("pideck:permissions:add-rule", input),
  permissionsRemoveRule: (id: string): Promise<any> => ipcRenderer.invoke("pideck:permissions:remove-rule", id),
  permissionsResolveApproval: (id: string, choice: string): Promise<any> =>
    ipcRenderer.invoke("pideck:permissions:resolve-approval", { id, choice }),
  onApprovalRequested: (cb: (req: any) => void): (() => void) => {
    const listener = (_e: unknown, req: any) => cb(req);
    ipcRenderer.on("pideck:approval-requested", listener);
    return () => ipcRenderer.removeListener("pideck:approval-requested", listener);
  },
  onApprovalCleared: (cb: (payload: { id: string }) => void): (() => void) => {
    const listener = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on("pideck:approval-cleared", listener);
    return () => ipcRenderer.removeListener("pideck:approval-cleared", listener);
  },
  onApprovalResolved: (cb: (payload: { id: string; choice: string }) => void): (() => void) => {
    const listener = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on("pideck:approval-resolved", listener);
    return () => ipcRenderer.removeListener("pideck:approval-resolved", listener);
  },
  onPermissionsChanged: (cb: (state: any) => void): (() => void) => {
    const listener = (_e: unknown, state: any) => cb(state);
    ipcRenderer.on("pideck:permissions-changed", listener);
    return () => ipcRenderer.removeListener("pideck:permissions-changed", listener);
  },

  lspGetSnapshot: (cwd: string): Promise<any> => ipcRenderer.invoke("pideck:lsp-get-snapshot", cwd),
  lspListSnapshots: (): Promise<any[]> => ipcRenderer.invoke("pideck:lsp-list-snapshots"),
  lspSetProject: (cwd: string | null): Promise<any> => ipcRenderer.invoke("pideck:lsp-set-project", cwd),
  lspRefresh: (cwd: string): Promise<any> => ipcRenderer.invoke("pideck:lsp-refresh", cwd),
  onLspUpdate: (cb: (snapshots: any[]) => void): (() => void) => {
    const listener = (_e: unknown, snaps: any[]) => cb(snaps);
    ipcRenderer.on("pideck:lsp-update", listener);
    return () => ipcRenderer.removeListener("pideck:lsp-update", listener);
  },

  onStatus: (cb: (status: any) => void): (() => void) => {
    const listener = (_e: unknown, s: any) => cb(s);
    ipcRenderer.on("pideck:session-status", listener);
    return () => ipcRenderer.removeListener("pideck:session-status", listener);
  },
};

contextBridge.exposeInMainWorld("pideck", api);

export type PiBridge = typeof api;
