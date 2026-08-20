import { describe, expect, it } from "vitest";
import {
  addCheckpoint,
  addTask,
  addTerminal,
  associateSession,
  associateWorktree,
  createTask,
  createTaskRegistry,
  isRemovable,
  listByOwner,
  listTasks,
  removeTask,
  removeTerminal,
  updateTask,
  type TaskRegistry,
} from "./tasks";

function withTask(): TaskRegistry {
  const t = createTask({ id: "t1", title: "Refactor auth", ownerSession: "main", createdAt: 1 });
  let r = addTask(createTaskRegistry(), t);
  r = associateWorktree(r, "t1", "task/refactor-auth", "/repo/.worktrees/t1");
  r = associateSession(r, "t1", "sess-9");
  return r;
}

describe("task-owned worktrees", () => {
  it("creates a task with safe defaults", () => {
    const r = withTask();
    expect(r.tasks.t1).toMatchObject({
      title: "Refactor auth",
      status: "proposed",
      branch: "task/refactor-auth",
      worktreePath: "/repo/.worktrees/t1",
      sessionId: "sess-9",
      dirty: false,
      terminalIds: [],
      checkpointIds: [],
    });
  });

  it("updates immutably", () => {
    const r = updateTask(withTask(), "t1", { status: "running", dirty: true });
    expect(r.tasks.t1.status).toBe("running");
    expect(r.tasks.t1.dirty).toBe(true);
    expect(withTask().tasks.t1.status).toBe("proposed");
  });

  it("tracks terminals and checkpoints without duplicates", () => {
    let r = addTerminal(withTask(), "t1", "term-1");
    r = addTerminal(r, "t1", "term-1"); // duplicate ignored
    r = addTerminal(r, "t1", "term-2");
    expect(r.tasks.t1.terminalIds).toEqual(["term-1", "term-2"]);
    r = addCheckpoint(r, "t1", "cp-1");
    expect(r.tasks.t1.checkpointIds).toEqual(["cp-1"]);
  });

  it("removes a task from the registry", () => {
    const r = removeTask(withTask(), "t1");
    expect(r.tasks.t1).toBeUndefined();
  });

  it("refuses to overwrite an existing task id", () => {
    const r = withTask();
    const dup = createTask({ id: "t1", title: "Other" });
    expect(addTask(r, dup)).toBe(r);
    expect(r.tasks.t1.title).toBe("Refactor auth");
  });

  it("returns clones from listTasks so the registry is not mutated", () => {
    const r = withTask();
    const listed = listTasks(r);
    listed[0].status = "completed";
    listed[0].terminalIds.push("x");
    expect(r.tasks.t1.status).toBe("proposed");
    expect(r.tasks.t1.terminalIds).toEqual([]);
  });

  it("removeTask is a no-op reference when the id is absent", () => {
    const r = withTask();
    expect(removeTask(r, "missing")).toBe(r);
  });

  it("removeTerminal is a no-op reference when the terminal is absent", () => {
    const r = withTask();
    expect(removeTerminal(r, "t1", "nope")).toBe(r);
  });

  it("isRemovable reflects the dirty flag", () => {
    const dirty = updateTask(withTask(), "t1", { dirty: true });
    expect(isRemovable(dirty.tasks.t1)).toBe(false);
    expect(isRemovable(withTask().tasks.t1)).toBe(true);
  });

  it("lists all and by owner", () => {
    let r = withTask();
    r = addTask(r, createTask({ id: "t2", title: "Scan", ownerSession: "worker" }));
    expect(listTasks(r)).toHaveLength(2);
    expect(listByOwner(r, "main").map((t) => t.id)).toEqual(["t1"]);
  });
});
