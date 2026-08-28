// Task-Owned Worktrees model for Parallel Work.
//
// A parallel implementation task owns a Pi session, a git branch, a git
// worktree, terminals, a preview, a diff, and checkpoints. This module models
// that ownership as pure, testable state; the git/PTY wiring builds on top.
// Removing a task must never silently destroy uncommitted work (callers check
// `dirty` before tear-down).

export type TaskStatus = "proposed" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  /** Parent session/agent that owns this task. */
  ownerSession?: string;
  /** Associated Pi session identity and persisted session files. */
  sessionId?: string;
  sessionFile?: string;
  parentSessionFile?: string;
  /** Project cwd plus optional isolated Git branch/worktree. */
  cwd?: string;
  branch?: string;
  worktreePath?: string;
  /** Whether the worktree has uncommitted changes (guards deletion). */
  dirty: boolean;
  terminalIds: string[];
  previewId?: string;
  checkpointIds: string[];
  createdAt: number;
}

export interface TaskRegistry {
  tasks: Record<string, Task>;
}

export function createTaskRegistry(): TaskRegistry {
  return { tasks: {} };
}

export function createTask(params: {
  id: string;
  title: string;
  ownerSession?: string;
  createdAt?: number;
  status?: TaskStatus;
}): Task {
  return {
    id: params.id,
    title: params.title,
    status: params.status ?? "proposed",
    ownerSession: params.ownerSession,
    dirty: false,
    terminalIds: [],
    checkpointIds: [],
    createdAt: params.createdAt ?? 0,
  };
}

export function addTask(registry: TaskRegistry, task: Task): TaskRegistry {
  // Refuse to clobber an existing task: overwriting would lose its branch,
  // worktree, terminals, checkpoints, and dirty state.
  if (registry.tasks[task.id]) return registry;
  return { tasks: { ...registry.tasks, [task.id]: task } };
}

export function updateTask(
  registry: TaskRegistry,
  id: string,
  patch: Partial<Omit<Task, "id">>
): TaskRegistry {
  const existing = registry.tasks[id];
  if (!existing) return registry;
  return { tasks: { ...registry.tasks, [id]: { ...existing, ...patch } } };
}

export function associateWorktree(
  registry: TaskRegistry,
  id: string,
  branch: string,
  worktreePath: string
): TaskRegistry {
  return updateTask(registry, id, { branch, worktreePath });
}

export function associateSession(
  registry: TaskRegistry,
  id: string,
  sessionId: string
): TaskRegistry {
  return updateTask(registry, id, { sessionId });
}

export function addTerminal(registry: TaskRegistry, id: string, terminalId: string): TaskRegistry {
  const task = registry.tasks[id];
  if (!task || task.terminalIds.includes(terminalId)) return registry;
  return updateTask(registry, id, { terminalIds: [...task.terminalIds, terminalId] });
}

export function removeTerminal(registry: TaskRegistry, id: string, terminalId: string): TaskRegistry {
  const task = registry.tasks[id];
  if (!task || !task.terminalIds.includes(terminalId)) return registry;
  return updateTask(registry, id, {
    terminalIds: task.terminalIds.filter((t) => t !== terminalId),
  });
}

export function addCheckpoint(registry: TaskRegistry, id: string, checkpointId: string): TaskRegistry {
  const task = registry.tasks[id];
  if (!task || task.checkpointIds.includes(checkpointId)) return registry;
  return updateTask(registry, id, { checkpointIds: [...task.checkpointIds, checkpointId] });
}

/** True when a task has no uncommitted work and may be safely torn down. */
export function isRemovable(task: Task): boolean {
  return !task.dirty;
}

function cloneTask(t: Task): Task {
  return { ...t, terminalIds: [...t.terminalIds], checkpointIds: [...t.checkpointIds] };
}

export function removeTask(registry: TaskRegistry, id: string): TaskRegistry {
  if (!registry.tasks[id]) return registry;
  const next = { ...registry.tasks };
  delete next[id];
  return { tasks: next };
}

/**
 * List tasks. Returned objects are shallow clones (including id arrays) so
 * callers cannot mutate registry state through them.
 */
export function listTasks(registry: TaskRegistry): Task[] {
  return Object.values(registry.tasks).map(cloneTask);
}

export function listByOwner(registry: TaskRegistry, ownerSession: string): Task[] {
  return Object.values(registry.tasks)
    .filter((t) => t.ownerSession === ownerSession)
    .map(cloneTask);
}
