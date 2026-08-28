import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { ProcessManager, type ProcessSnapshot } from "./process-manager";
import {
  addTask,
  addTerminal,
  createTask,
  createTaskRegistry,
  listTasks,
  removeTask,
  updateTask,
  type Task,
  type TaskRegistry,
} from "../src/tasks";

export interface TaskResources {
  title: string;
  ownerSession?: string;
  sessionId: string;
  sessionFile: string;
  parentSessionFile: string;
  cwd: string;
  branch?: string;
  worktreePath?: string;
}

export interface TaskExitResult {
  task: Task;
  removed: boolean;
}

export class TaskManager {
  private registry: TaskRegistry = createTaskRegistry();
  private listeners = new Set<(tasks: Task[]) => void>();
  private exiting = new Set<string>();

  constructor(private readonly processes: ProcessManager) {}

  subscribe(listener: (tasks: Task[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): Task[] {
    return listTasks(this.registry);
  }

  get(id: string): Task | undefined {
    const task = this.registry.tasks[id];
    return task ? cloneTask(task) : undefined;
  }

  findBySessionFile(sessionFile: string | null | undefined): Task | undefined {
    if (!sessionFile) return undefined;
    const task = Object.values(this.registry.tasks).find((candidate) => candidate.sessionFile === sessionFile);
    return task ? cloneTask(task) : undefined;
  }

  register(resources: TaskResources): Task {
    if (!resources.sessionId || !resources.sessionFile || !resources.parentSessionFile || !resources.cwd) {
      throw new Error("task resources are incomplete");
    }
    const task = createTask({
      id: randomUUID(),
      title: resources.title,
      ownerSession: resources.ownerSession,
      createdAt: Date.now(),
      status: "running",
    });
    const complete: Task = {
      ...task,
      sessionId: resources.sessionId,
      sessionFile: resources.sessionFile,
      parentSessionFile: resources.parentSessionFile,
      cwd: resources.cwd,
      branch: resources.branch,
      worktreePath: resources.worktreePath,
    };
    this.registry = addTask(this.registry, complete);
    this.broadcast();
    return cloneTask(complete);
  }

  spawn(taskId: string, command: string, cwd: string): ProcessSnapshot {
    const task = this.registry.tasks[taskId];
    if (!task) throw new Error("unknown task");
    if (task.status !== "running") throw new Error("task is not running");
    if (!task.cwd || !isWithin(task.cwd, cwd)) throw new Error("process cwd does not match task cwd");

    const process = this.processes.spawn({
      command,
      cwd,
      owner: task.id,
      ownerSession: task.sessionId,
    });
    this.registry = addTerminal(this.registry, task.id, process.id);
    this.broadcast();
    return process;
  }

  async exit<T extends object>(params: {
    taskId: string;
    keep: boolean;
    dirty: boolean;
    cleanup: (task: Task) => Promise<T>;
  }): Promise<T & TaskExitResult> {
    const current = this.registry.tasks[params.taskId];
    if (!current) throw new Error("unknown task");
    if (this.exiting.has(current.id)) throw new Error("task exit already in progress");
    this.exiting.add(current.id);

    try {
      this.registry = updateTask(this.registry, current.id, { dirty: params.dirty });
      const task = this.registry.tasks[current.id];
      if (!params.keep && task.dirty) {
        this.broadcast();
        throw new Error("Cannot discard a task worktree with uncommitted changes");
      }

      await this.processes.killByOwner(task.id);
      const cleanupResult = await params.cleanup(cloneTask(task));

      if (params.keep) {
        this.registry = updateTask(this.registry, task.id, { status: "paused" });
      } else {
        this.registry = removeTask(this.registry, task.id);
      }
      this.broadcast();

      return Object.assign(cleanupResult, {
        task: cloneTask(params.keep ? this.registry.tasks[task.id] : task),
        removed: !params.keep,
      });
    } finally {
      this.exiting.delete(current.id);
    }
  }

  resumeForSession(sessionFile: string | null | undefined): Task | undefined {
    if (!sessionFile) return undefined;
    const task = Object.values(this.registry.tasks).find((candidate) => candidate.sessionFile === sessionFile);
    if (!task) return undefined;
    if (task.status === "paused") {
      this.registry = updateTask(this.registry, task.id, { status: "running" });
      this.broadcast();
    }
    return this.get(task.id);
  }

  private broadcast(): void {
    const tasks = this.list();
    for (const listener of this.listeners) {
      try {
        listener(tasks);
      } catch {}
    }
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    terminalIds: [...task.terminalIds],
    checkpointIds: [...task.checkpointIds],
  };
}
