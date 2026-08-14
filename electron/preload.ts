import { contextBridge, ipcRenderer } from "electron";

const api = {
  listSessions: (): Promise<any> => ipcRenderer.invoke("pideck:list-sessions"),
  getSessionMessages: (path: string): Promise<{ messages: any[]; startOffset: number }> =>
    ipcRenderer.invoke("pideck:get-session-messages", path),
  getSessionWindow: (path: string, endOffset: number, countBytes?: number): Promise<{ messages: any[]; startOffset: number }> =>
    ipcRenderer.invoke("pideck:get-session-window", path, endOffset, countBytes),
  getToolOutput: (toolCallId: string): Promise<{ content: string; truncated: boolean }> =>
    ipcRenderer.invoke("pideck:get-tool-output", toolCallId),
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
  getModels: (): Promise<any[]> => ipcRenderer.invoke("pideck:get-models"),
  getCommands: (): Promise<any[]> => ipcRenderer.invoke("pideck:get-commands"),
  setModel: (provider: string, modelId: string): Promise<any> =>
    ipcRenderer.invoke("pideck:set-model", provider, modelId),
  setThinking: (level: string): Promise<any> => ipcRenderer.invoke("pideck:set-thinking", level),
  getThinkingLevels: (): Promise<string[]> => ipcRenderer.invoke("pideck:get-thinking-levels"),
  setSessionName: (name: string): Promise<any> => ipcRenderer.invoke("pideck:set-session-name", name),
  compact: (): Promise<any> => ipcRenderer.invoke("pideck:compact"),

  // Branching / worktrees
  getTree: (): Promise<any> => ipcRenderer.invoke("pideck:get-tree"),
  getHistory: (): Promise<any> => ipcRenderer.invoke("pideck:get-history"),
  prepareRollback: (entryId: string): Promise<any> => ipcRenderer.invoke("pideck:rollback:prepare", entryId),
  commitRollback: (planId: string): Promise<any> => ipcRenderer.invoke("pideck:rollback:commit", planId),
  undoRollback: (): Promise<any> => ipcRenderer.invoke("pideck:rollback:undo"),
  getForkMessages: (): Promise<any[]> => ipcRenderer.invoke("pideck:get-fork-messages"),
  fork: (entryId: string): Promise<any> => ipcRenderer.invoke("pideck:fork", entryId),
  clone: (): Promise<any> => ipcRenderer.invoke("pideck:clone"),
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
  onStatus: (cb: (status: any) => void): (() => void) => {
    const listener = (_e: unknown, s: any) => cb(s);
    ipcRenderer.on("pideck:session-status", listener);
    return () => ipcRenderer.removeListener("pideck:session-status", listener);
  },
};

contextBridge.exposeInMainWorld("pideck", api);

export type PiBridge = typeof api;
