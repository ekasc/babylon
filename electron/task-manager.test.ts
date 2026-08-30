import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessManager } from "./process-manager";
import { TaskManager } from "./task-manager";

const roots: string[] = [];
const processes: ProcessManager[] = [];

afterEach(() => {
  for (const manager of processes) manager.dispose();
  processes.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "babylon-task-"));
  roots.push(cwd);
  const processManager = new ProcessManager({ killGraceMs: 100 });
  processes.push(processManager);
  const manager = new TaskManager(processManager);
  const task = manager.register({
    title: "Refactor auth",
    ownerSession: "parent-session",
    sessionId: "task-session",
    sessionFile: join(cwd, "task.jsonl"),
    parentSessionFile: join(cwd, "parent.jsonl"),
    cwd,
    branch: "pideck/refactor-auth",
    worktreePath: cwd,
  });
  return { cwd, manager, processManager, task };
}

async function waitForProcess(
  manager: ProcessManager,
  id: string,
  predicate: (state: string) => boolean,
  timeoutMs = 3000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const process = manager.get(id);
    if (process && predicate(process.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${id} did not reach expected state`);
}

describe("TaskManager", () => {
  it("registers the session, worktree, and branch as one running task", () => {
    const { cwd, manager, task } = setup();
    expect(manager.get(task.id)).toMatchObject({
      status: "running",
      ownerSession: "parent-session",
      sessionId: "task-session",
      sessionFile: join(cwd, "task.jsonl"),
      parentSessionFile: join(cwd, "parent.jsonl"),
      cwd,
      branch: "pideck/refactor-auth",
      worktreePath: cwd,
    });
    expect(manager.findBySessionFile(join(cwd, "task.jsonl"))?.id).toBe(task.id);
  });

  it("stamps spawned processes and records their ids on the task", async () => {
    const { cwd, manager, processManager, task } = setup();
    const process = manager.spawn(task.id, `node -e "setTimeout(()=>process.exit(0), 20)"`, cwd);
    expect(process).toMatchObject({ owner: task.id, ownerSession: "task-session", cwd });
    expect(manager.get(task.id)?.terminalIds).toEqual([process.id]);
    await waitForProcess(processManager, process.id, (state) => state === "exited");
  });

  it("allows task subdirectories and rejects paths outside the task cwd", async () => {
    const { cwd, manager, processManager, task } = setup();
    const subdir = join(cwd, "packages", "app");
    mkdirSync(subdir, { recursive: true });
    const process = manager.spawn(task.id, `node -e "process.exit(0)"`, subdir);
    await waitForProcess(processManager, process.id, (state) => state === "exited");
    expect(() => manager.spawn(task.id, "echo nope", tmpdir())).toThrow(/cwd does not match/);
  });

  it("refuses destructive cleanup for a dirty worktree", async () => {
    const { manager, task } = setup();
    let cleaned = false;
    await expect(
      manager.exit({
        taskId: task.id,
        keep: false,
        dirty: true,
        cleanup: async () => {
          cleaned = true;
          return {};
        },
      })
    ).rejects.toThrow(/uncommitted changes/);
    expect(cleaned).toBe(false);
    expect(manager.get(task.id)).toMatchObject({ dirty: true, status: "running" });
  });

  it("kills owned processes before cleanup and removes a discarded task", async () => {
    const { cwd, manager, processManager, task } = setup();
    const process = manager.spawn(task.id, `node -e "setInterval(()=>{}, 100)"`, cwd);
    await waitForProcess(processManager, process.id, (state) => state === "running");

    let stateDuringCleanup: string | undefined;
    const result = await manager.exit({
      taskId: task.id,
      keep: false,
      dirty: false,
      cleanup: async () => {
        stateDuringCleanup = processManager.get(process.id)?.state;
        return { cleaned: true };
      },
    });

    expect(stateDuringCleanup).toBe("killed");
    expect(result).toMatchObject({ cleaned: true, removed: true });
    expect(manager.get(task.id)).toBeUndefined();
  });

  it("rejects concurrent exits before cleanup can run twice", async () => {
    const { manager, task } = setup();
    let releaseCleanup: (() => void) | undefined;
    const first = manager.exit({
      taskId: task.id,
      keep: true,
      dirty: false,
      cleanup: () => new Promise<{ kept: true }>((resolve) => {
        releaseCleanup = () => resolve({ kept: true });
      }),
    });

    await expect(
      manager.exit({ taskId: task.id, keep: true, dirty: false, cleanup: async () => ({ kept: true }) })
    ).rejects.toThrow(/already in progress/);
    releaseCleanup?.();
    await expect(first).resolves.toMatchObject({ removed: false });
  });

  it("pauses a kept task and resumes it when its session opens again", async () => {
    const { manager, task } = setup();
    const result = await manager.exit({
      taskId: task.id,
      keep: true,
      dirty: true,
      cleanup: async () => ({ kept: true }),
    });
    expect(result).toMatchObject({ kept: true, removed: false });
    expect(manager.get(task.id)).toMatchObject({ status: "paused", dirty: true });

    expect(manager.resumeForSession(task.sessionFile!)?.status).toBe("running");
  });
});
