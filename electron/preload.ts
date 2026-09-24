import { contextBridge, ipcRenderer } from "electron";
import type { Bot, BotGroup } from "../src/bots";
import type { Bridge, PromptImage, SessionWindow, SimTabState } from "../src/bridge";
import type { SimEmulation } from "../src/lib/simulator";

function on<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: Bridge = {
  listSessions: () => ipcRenderer.invoke("pideck:list-sessions"),
  getSessionMessages: (path: string): Promise<SessionWindow> =>
    ipcRenderer.invoke("pideck:get-session-messages", path),
  getSessionWindow: (path: string, endOffset: number, countBytes?: number): Promise<SessionWindow> =>
    ipcRenderer.invoke("pideck:get-session-window", path, endOffset, countBytes),
  getToolOutput: (sessionFile: string, toolCallId: string): Promise<{ content: string; truncated: boolean }> =>
    ipcRenderer.invoke("pideck:get-tool-output", sessionFile, toolCallId),
  deleteSession: (path: string): Promise<void> => ipcRenderer.invoke("pideck:delete-session", path),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("pideck:pick-folder"),
  openSession: (opts: { path?: string; cwd: string; requestId?: number }): Promise<void> =>
    ipcRenderer.invoke("pideck:open-session", opts),

  botsList: () => ipcRenderer.invoke("pideck:bots-list"),
  botsCreate: (input) => ipcRenderer.invoke("pideck:bots-create", input),
  botsUpdate: (id: string, patch) => ipcRenderer.invoke("pideck:bots-update", id, patch),
  botsDelete: (id: string): Promise<{ removed: boolean }> => ipcRenderer.invoke("pideck:bots-delete", id),
  botsOpen: (id: string): Promise<{ sessionFile: string | null; bot: Bot }> =>
    ipcRenderer.invoke("pideck:bots-open", id),
  onBotsUpdate: (cb) => on("pideck:bots-update", cb),
  groupsList: () => ipcRenderer.invoke("pideck:groups-list"),
  groupsCreate: (input) => ipcRenderer.invoke("pideck:groups-create", input),
  groupsUpdate: (id: string, patch) => ipcRenderer.invoke("pideck:groups-update", id, patch),
  groupsDelete: (id: string): Promise<{ removed: boolean }> => ipcRenderer.invoke("pideck:groups-delete", id),
  groupsOpen: (id: string): Promise<{ sessionFile: string | null; group: BotGroup }> =>
    ipcRenderer.invoke("pideck:groups-open", id),
  onGroupsUpdate: (cb) => on("pideck:groups-update", cb),
  groupSend: (groupId: string, text: string) =>
    ipcRenderer.invoke("pideck:group-send", groupId, text),
  botsMessage: (targetId: string, text: string, fromId?: string) =>
    ipcRenderer.invoke("pideck:bots-message", targetId, text, fromId),
  botsDefaultGet: () => ipcRenderer.invoke("pideck:bots-default-get"),
  botsDefaultSet: (input) => ipcRenderer.invoke("pideck:bots-default-set", input),
  projectSettingsGet: (cwd: string) => ipcRenderer.invoke("pideck:project-settings-get", cwd),
  projectSettingsMembers: (hash: string, memberIds: string[]) =>
    ipcRenderer.invoke("pideck:project-settings-members", hash, memberIds),
  projectSettingsFreespeak: (hash: string, on: boolean) =>
    ipcRenderer.invoke("pideck:project-settings-freespeak", hash, on),
  projectDefaultUpdate: (hash: string, patch) =>
    ipcRenderer.invoke("pideck:project-default-update", hash, patch),
  projectDefaultReset: (hash: string) => ipcRenderer.invoke("pideck:project-default-reset", hash),
  handoffCreate: (projectHash: string, sourceFile: string) =>
    ipcRenderer.invoke("pideck:handoff-create", projectHash, sourceFile),
  handoffList: (sourceFile: string) => ipcRenderer.invoke("pideck:handoff-list", sourceFile),
  handoffConsume: (handoffId: string, liveFile: string) =>
    ipcRenderer.invoke("pideck:handoff-consume", handoffId, liveFile),

  prompt: (message: string, images: PromptImage[] | undefined, streamingBehavior: "steer" | "followUp" | undefined, sessionFile: string) =>
    ipcRenderer.invoke("pideck:prompt", message, images, streamingBehavior, sessionFile),
  abort: (sessionFile: string) => ipcRenderer.invoke("pideck:abort", { sessionFile }),
  goalGet: (sessionId: string, cwd: string) => ipcRenderer.invoke("pideck:goal-get", sessionId, cwd),
  goalControl: (sessionFile: string, args: string) => ipcRenderer.invoke("pideck:goal-control", { sessionFile, args }),
  executionList: () => ipcRenderer.invoke("pideck:execution-list"),
  executionActivate: (cwd: string, sessionFile?: string) => ipcRenderer.invoke("pideck:execution-activate", { cwd, sessionFile }),
  executionDeactivate: (cwd: string, expectedSessionFile: string) =>
    ipcRenderer.invoke("pideck:execution-deactivate", { cwd, expectedSessionFile }),
  onExecutionChanged: (cb) => on("pideck_execution_changed", cb),
  beginGoalPrompt: (sessionFile: string, objective: string, message: string, images?: unknown[], streamingBehavior?: string) =>
    ipcRenderer.invoke("pideck:goal-begin-prompt", { sessionFile, objective, message, images, streamingBehavior }),
  designGet: (sessionId: string, cwd: string) => ipcRenderer.invoke("pideck:design-get", sessionId, cwd),
  designControl: (sessionFile: string, args: string) => ipcRenderer.invoke("pideck:design-control", { sessionFile, args }),
  beginDesignPrompt: (sessionFile: string, subject: string, message: string, images?: unknown[], streamingBehavior?: string) =>
    ipcRenderer.invoke("pideck:design-begin-prompt", { sessionFile, subject, message, images, streamingBehavior }),
  releaseSession: (path: string): Promise<{ released: boolean }> =>
    ipcRenderer.invoke("pideck:session:release", path),
  refreshSession: (path: string): Promise<boolean> => ipcRenderer.invoke("pideck:refresh-session", path),

  getMessages: (sessionFile: string) => ipcRenderer.invoke("pideck:get-messages", sessionFile),
  getState: (sessionFile: string) => ipcRenderer.invoke("pideck:get-state", { sessionFile }),
  getStats: (sessionFile: string) => ipcRenderer.invoke("pideck:get-stats", sessionFile),
  gitStatus: (cwd: string) => ipcRenderer.invoke("pideck:git-status", cwd),
  gitStatusDetails: (cwd: string) => ipcRenderer.invoke("pideck:git-status-details", cwd),
  gitDiffFile: (cwd: string, file: string): Promise<string> => ipcRenderer.invoke("pideck:git-diff-file", cwd, file),
  gitBranches: (cwd: string) => ipcRenderer.invoke("pideck:git-branches", cwd),
  gitBranchCreate: (cwd: string, name: string, switchTo: boolean) =>
    ipcRenderer.invoke("pideck:git-branch-create", cwd, name, switchTo),
  gitBranchSwitch: (cwd: string, name: string, options?: { stash?: boolean }) =>
    ipcRenderer.invoke("pideck:git-branch-switch", cwd, name, options),
  gitCommitPush: (cwd: string, requestId: string) => ipcRenderer.invoke("pideck:git-commit-push", cwd, requestId),
  onGitCommitPushProgress: (cb) => on("pideck:git-commit-push-progress", cb),
  gitCommit: (cwd: string, message: string) => ipcRenderer.invoke("pideck:git-commit", cwd, message),
  gitPush: (cwd: string) => ipcRenderer.invoke("pideck:git-push", cwd),
  gitPull: (cwd: string) => ipcRenderer.invoke("pideck:git-pull", cwd),
  gitPrContext: (cwd: string) => ipcRenderer.invoke("pideck:git-pr-context", cwd),
  gitPrSuggest: (cwd: string) => ipcRenderer.invoke("pideck:git-pr-suggest", cwd),
  gitPrCreate: (cwd: string, input: { title: string; body?: string }) =>
    ipcRenderer.invoke("pideck:git-pr-create", cwd, input),
  gitStageFile: (cwd: string, file: string): Promise<void> => ipcRenderer.invoke("pideck:git-stage-file", cwd, file),
  gitUnstageFile: (cwd: string, file: string): Promise<void> => ipcRenderer.invoke("pideck:git-unstage-file", cwd, file),
  gitDiscardFile: (cwd: string, file: string): Promise<void> => ipcRenderer.invoke("pideck:git-discard-file", cwd, file),
  gitStageHunk: (cwd: string, file: string, patch: string): Promise<void> => ipcRenderer.invoke("pideck:git-stage-hunk", cwd, file, patch),
  gitDiscardHunk: (cwd: string, file: string, patch: string): Promise<void> => ipcRenderer.invoke("pideck:git-discard-hunk", cwd, file, patch),
  getModels: (cwd: string) => ipcRenderer.invoke("pideck:get-models", cwd),
  warmProject: (cwd: string) => ipcRenderer.invoke("pideck:warm-project", cwd),
  getCommands: (sessionFile: string) => ipcRenderer.invoke("pideck:get-commands", sessionFile),
  setModel: (sessionFile: string, provider: string, modelId: string) =>
    ipcRenderer.invoke("pideck:set-model", sessionFile, provider, modelId),
  setThinking: (sessionFile: string, level: string) => ipcRenderer.invoke("pideck:set-thinking", sessionFile, level),
  getThinkingLevels: (sessionFile: string): Promise<string[]> => ipcRenderer.invoke("pideck:get-thinking-levels", sessionFile),
  listFonts: (): Promise<string[]> => ipcRenderer.invoke("pideck:list-fonts"),
  setSessionName: (sessionFile: string, name: string) => ipcRenderer.invoke("pideck:set-session-name", sessionFile, name),
  renameSession: (path: string, name: string) => ipcRenderer.invoke("pideck:rename-session", { path, name }),
  compact: (sessionFile: string, customInstructions?: string) => ipcRenderer.invoke("pideck:compact", sessionFile, customInstructions),
  getSettings: () => ipcRenderer.invoke("pideck:get-settings"),
  setSettings: (patch) => ipcRenderer.invoke("pideck:set-settings", patch),

  // Branching / worktrees
  getTree: (sessionFile: string) => ipcRenderer.invoke("pideck:get-tree", sessionFile),
  getHistory: (sessionFile: string) => ipcRenderer.invoke("pideck:get-history", sessionFile),
  getTurnChanges: (sessionFile: string, entryId: string) => ipcRenderer.invoke("pideck:turn-changes", sessionFile, entryId),
  getTurnFileDiff: (sessionFile: string, entryId: string, path: string) =>
    ipcRenderer.invoke("pideck:turn-file-diff", sessionFile, entryId, path),
  prepareRollback: (sessionFile: string, entryId: string) => ipcRenderer.invoke("pideck:rollback:prepare", sessionFile, entryId),
  commitRollback: (planId: string) => ipcRenderer.invoke("pideck:rollback:commit", planId),
  undoRollback: (sessionFile: string) => ipcRenderer.invoke("pideck:rollback:undo", sessionFile),
  getForkMessages: (sessionFile: string) => ipcRenderer.invoke("pideck:get-fork-messages", sessionFile),
  fork: (sessionFile: string, entryId: string) => ipcRenderer.invoke("pideck:fork", sessionFile, entryId),
  clone: (sessionFile: string) => ipcRenderer.invoke("pideck:clone", sessionFile),
  taskList: () => ipcRenderer.invoke("pideck:task-list"),
  taskGet: (id: string) => ipcRenderer.invoke("pideck:task-get", id),
  taskSpawn: (taskId: string, command: string, cwd: string) =>
    ipcRenderer.invoke("pideck:task-spawn", taskId, command, cwd),
  taskSetContract: (taskId: string, contract) =>
    ipcRenderer.invoke("pideck:task-set-contract", taskId, contract),
  taskComplete: (taskId: string, results) =>
    ipcRenderer.invoke("pideck:task-complete", taskId, results),
  onTaskUpdate: (cb) => on("pideck:task-update", cb),
  hooksList: () => ipcRenderer.invoke("pideck:hooks-list"),
  hooksRegister: (hook) => ipcRenderer.invoke("pideck:hooks-register", hook),
  hooksRemove: (id: string) => ipcRenderer.invoke("pideck:hooks-remove", id),
  onHooksUpdate: (cb) => on("pideck:hooks-update", cb),
  contractsList: () => ipcRenderer.invoke("pideck:contracts-list"),
  contractsGet: (id: string) => ipcRenderer.invoke("pideck:contracts-get", id),
  attentionList: () => ipcRenderer.invoke("pideck:attention-list"),
  attentionResolve: (id: string) => ipcRenderer.invoke("pideck:attention-resolve", id),
  onAttentionUpdate: (cb) => on("pideck:attention-update", cb),
  worktreeInfo: (sessionFile: string) => ipcRenderer.invoke("pideck:worktree-info", sessionFile),
  worktreeCreate: (opts: { name: string; description?: string; useGit?: boolean }, sessionFile: string) =>
    ipcRenderer.invoke("pideck:worktree-create", opts, sessionFile),
  worktreeExit: (opts: { keep: boolean }, sessionFile: string) =>
    ipcRenderer.invoke("pideck:worktree-exit", opts, sessionFile),

  uiRespond: (resp: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke("pideck:ui-respond", resp),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("pideck:open-external", url),

  // Device simulator (tabbed separate-process guests + CDP emulation)
  simOpenTab: (url?: string): Promise<SimTabState> =>
    ipcRenderer.invoke("pideck:sim-open-tab", { url: url ?? null }),
  simActivate: (tabId: string): Promise<SimTabState> =>
    ipcRenderer.invoke("pideck:sim-activate", { tabId }),
  simCloseTab: (tabId?: string | null): Promise<{ closed: boolean }> =>
    ipcRenderer.invoke("pideck:sim-close-tab", { tabId: tabId ?? null }),
  simTabs: (): Promise<{ tabs: SimTabState[]; activeId: string | null }> =>
    ipcRenderer.invoke("pideck:sim-tabs"),
  simAttach: (): Promise<{ tabs: SimTabState[]; activeId: string | null; emulation: SimEmulation | null }> =>
    ipcRenderer.invoke("pideck:sim-attach"),
  simDetach: (): Promise<void> => ipcRenderer.invoke("pideck:sim-detach"),
  simClose: (): Promise<void> => ipcRenderer.invoke("pideck:sim-close"),
  simBounds: (tabId: string | undefined, rect: { x: number; y: number; width: number; height: number }): Promise<void> =>
    ipcRenderer.invoke("pideck:sim-bounds", { tabId: tabId ?? null, rect }),
  simEmulate: (tabId: string | undefined, emulation): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("pideck:sim-emulate", { tabId: tabId ?? null, emulation }),
  simViewport: (tabId: string | undefined, viewport): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("pideck:sim-viewport", { tabId: tabId ?? null, viewport }),
  simZoom: (tabId: string | undefined, factor: number): Promise<{ zoomFactor: number }> =>
    ipcRenderer.invoke("pideck:sim-zoom", { tabId: tabId ?? null, factor }),
  simFitZoom: (tabId: string | undefined, scale: number): Promise<void> =>
    ipcRenderer.invoke("pideck:sim-fit-zoom", { tabId: tabId ?? null, scale }),
  simHardReload: (tabId?: string | null): Promise<void> =>
    ipcRenderer.invoke("pideck:sim-hard-reload", { tabId: tabId ?? null }),
  simDevTools: (tabId?: string | null): Promise<void> =>
    ipcRenderer.invoke("pideck:sim-devtools", { tabId: tabId ?? null }),
  simClearCookies: (tabId?: string | null): Promise<void> =>
    ipcRenderer.invoke("pideck:sim-clear-cookies", { tabId: tabId ?? null }),
  simClearCache: (tabId?: string | null): Promise<void> =>
    ipcRenderer.invoke("pideck:sim-clear-cache", { tabId: tabId ?? null }),
  simMenu: (opts: { tabId?: string | null; showDeviceToolbar: boolean }): Promise<{ deviceToolbar?: boolean; dismissed?: boolean }> =>
    ipcRenderer.invoke("pideck:sim-menu", { tabId: opts.tabId ?? null, showDeviceToolbar: opts.showDeviceToolbar }),
  simNavigate: (tabId: string | undefined, url: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("pideck:sim-navigate", { tabId: tabId ?? null, url }),
  simReload: (tabId?: string | null): Promise<void> => ipcRenderer.invoke("pideck:sim-reload", { tabId: tabId ?? null }),
  simBack: (tabId?: string | null): Promise<void> => ipcRenderer.invoke("pideck:sim-back", { tabId: tabId ?? null }),
  simForward: (tabId?: string | null): Promise<void> => ipcRenderer.invoke("pideck:sim-forward", { tabId: tabId ?? null }),
  simProbe: (port: number): Promise<{ open: boolean }> => ipcRenderer.invoke("pideck:sim-probe", port),
  onSimEvent: (cb) => on("pideck:sim-event", cb),

  // Threads + subagents activity
  activityList: () => ipcRenderer.invoke("pideck:activity:list"),
  threadsControl: (action: string, threadId: string, message?: string) =>
    ipcRenderer.invoke("pideck:threads:control", { action, threadId, message }),
  threadsPromote: (threadId: string) => ipcRenderer.invoke("pideck:threads:promote", threadId),
  subagentsControl: (action: string, runId: string, message?: string) =>
    ipcRenderer.invoke("pideck:subagents:control", { action, runId, message }),
  subagentsPromote: (runId: string) =>
    ipcRenderer.invoke("pideck:subagents:promote", runId),
  onActivityUpdate: (cb) => on("pideck:activity-update", cb),

  // Workflows (pi-dynamic-workflows run state)
  workflowsList: () => ipcRenderer.invoke("pideck:workflows:list"),
  workflowsGet: (runId: string) => ipcRenderer.invoke("pideck:workflows:get", runId),
  workflowsDelete: (runId: string) => ipcRenderer.invoke("pideck:workflows:delete", runId),
  workflowsControl: (action: string, runId: string) =>
    ipcRenderer.invoke("pideck:workflows:control", { action, runId }),
  onSessionsUpdate: (cb) => on("pideck:sessions-update", cb),
  onWorkflowsUpdate: (cb) => on("pideck:workflows-update", cb),

  processList: () => ipcRenderer.invoke("pideck:process-list"),
  processSpawn: (opts: { command: string; cwd: string; owner?: string; ownerSession?: string }) =>
    ipcRenderer.invoke("pideck:process-spawn", opts),
  processKill: (id: string) => ipcRenderer.invoke("pideck:process-kill", id),
  onProcessUpdate: (cb) => on("pideck:process-update", cb),

  onAgentEvents: (cb) => on("pideck:agent-events", cb),
  onAgentEvent: (cb) => on("pideck:agent-event", cb),

  permissionsGet: () => ipcRenderer.invoke("pideck:permissions:get"),
  permissionsSetMode: (mode: string) => ipcRenderer.invoke("pideck:permissions:set-mode", mode),
  permissionsAddRule: (input) => ipcRenderer.invoke("pideck:permissions:add-rule", input),
  permissionsRemoveRule: (id: string) => ipcRenderer.invoke("pideck:permissions:remove-rule", id),
  permissionsResolveApproval: (id: string, choice: string) =>
    ipcRenderer.invoke("pideck:permissions:resolve-approval", { id, choice }),
  onApprovalRequested: (cb) => on("pideck:approval-requested", cb),
  onApprovalCleared: (cb) => on("pideck:approval-cleared", cb),
  onApprovalResolved: (cb) => on("pideck:approval-resolved", cb),
  approvalsPending: () => ipcRenderer.invoke("pideck:approvals:pending"),
  onDaemonStatus: (cb) => on("pideck:daemon-status", cb),
  onPermissionsChanged: (cb) => on("pideck:permissions-changed", cb),

  lspGetSnapshot: (cwd: string) => ipcRenderer.invoke("pideck:lsp-get-snapshot", cwd),
  lspListSnapshots: () => ipcRenderer.invoke("pideck:lsp-list-snapshots"),
  lspSetProject: (cwd: string | null) => ipcRenderer.invoke("pideck:lsp-set-project", cwd),
  lspRefresh: (cwd: string) => ipcRenderer.invoke("pideck:lsp-refresh", cwd),
  onLspUpdate: (cb) => on("pideck:lsp-update", cb),

  canvasList: (cwd: string) => ipcRenderer.invoke("pideck:canvas-list", cwd),
  canvasWrite: (cwd: string, name: string, text: string) =>
    ipcRenderer.invoke("pideck:canvas-write", cwd, name, text),
  canvasWatch: (cwd: string | null, name: string | null) =>
    ipcRenderer.invoke("pideck:canvas-watch", cwd, name),
  canvasClassify: (cwd: string, name: string, crops) =>
    ipcRenderer.invoke("pideck:canvas-classify", cwd, name, crops),
  canvasUnwatch: () => ipcRenderer.invoke("pideck:canvas-unwatch"),
  onCanvasChanged: (cb) => on("pideck:canvas-changed", cb),
  onCanvasScenes: (cb) => on("pideck:canvas-scenes", cb),

  onStatus: (cb) => on("pideck:session-status", cb),
};

contextBridge.exposeInMainWorld("pideck", api);

export type PiBridge = typeof api;
