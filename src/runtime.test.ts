import { describe, expect, it } from "vitest";
import {
  createRuntime,
  makeId,
  restoreRuntime,
  RUNTIME_VERSION,
  snapshotRuntime,
  type RuntimeState,
} from "./runtime";
import { addTask, createTask, type TaskRegistry } from "./tasks";

describe("babylon runtime authority", () => {
  it("creates an empty runtime with the current version", () => {
    const r = createRuntime();
    expect(r.version).toBe(RUNTIME_VERSION);
    expect(Object.keys(r.tasks.tasks)).toHaveLength(0);
    expect(Object.keys(r.contracts)).toHaveLength(0);
  });

  it("snapshots and restores preserving domain state", () => {
    let r: RuntimeState = createRuntime();
    r = { ...r, tasks: addTask(r.tasks, createTask({ id: "t1", title: "x" })) as TaskRegistry };
    const json = snapshotRuntime(r);
    const restored = restoreRuntime(json);
    expect(restored.tasks.tasks.t1.title).toBe("x");
    expect(restored.version).toBe(RUNTIME_VERSION);
  });

  it("refuses to restore an incompatible version", () => {
    const bad = JSON.stringify({ ...createRuntime(), version: 999 });
    expect(() => restoreRuntime(bad)).toThrow(/version/);
  });

  it("refuses to snapshot an unexpected version", () => {
    const r = { ...createRuntime(), version: 2 };
    expect(() => snapshotRuntime(r)).toThrow(/version/);
  });

  it("makes unique, prefixed ids", () => {
    const a = makeId("task");
    const b = makeId("task");
    expect(a).not.toBe(b);
    expect(a.startsWith("task-")).toBe(true);
  });
});
