import { describe, expect, it } from "vitest";
import {
  createProcess,
  createRegistry,
  detectPorts,
  listActive,
  listByOwner,
  listHistory,
  removeProcess,
  terminateProcess,
  updateProcess,
  type ProcessRegistry,
} from "./process-model";

function withProcess(state: "running" | "starting" = "running"): ProcessRegistry {
  return createProcess(createRegistry(), {
    id: "p1",
    command: "pnpm dev",
    cwd: "/project",
    ownerSession: "main",
    owner: "Main Agent",
    pid: 1234,
    startedAt: 100,
    state,
  });
}

describe("process registry", () => {
  it("creates a tracked process with defaults", () => {
    const r = withProcess();
    expect(r.processes.p1).toMatchObject({
      command: "pnpm dev",
      cwd: "/project",
      owner: "Main Agent",
      pid: 1234,
      state: "running",
      detectedPorts: [],
    });
  });

  it("updates fields immutably", () => {
    const r = updateProcess(withProcess(), "p1", { pid: 999 });
    expect(r.processes.p1.pid).toBe(999);
    expect(withProcess().processes.p1.pid).toBe(1234);
  });

  it("dedupes and sorts detected ports", () => {
    let r = detectPorts(withProcess(), "p1", [5173, 3000]);
    r = detectPorts(r, "p1", [5173, 8080]);
    expect(r.processes.p1.detectedPorts).toEqual([3000, 5173, 8080]);
  });

  it("terminates into history without losing the record", () => {
    const r = terminateProcess(withProcess(), "p1", { exitedAt: 200, exitCode: 0, state: "exited" });
    expect(r.processes.p1.state).toBe("exited");
    expect(r.processes.p1.exitCode).toBe(0);
    expect(listHistory(r)).toHaveLength(1);
    expect(listActive(r)).toHaveLength(0);
  });

  it("lists active and history separately", () => {
    let r = withProcess();
    r = createProcess(r, { id: "p2", command: "vitest", cwd: "/project", state: "running" });
    r = terminateProcess(r, "p1", { exitCode: 1, state: "failed" });
    expect(listActive(r).map((p) => p.id).sort()).toEqual(["p2"]);
    expect(listHistory(r).map((p) => p.id)).toEqual(["p1"]);
  });

  it("filters by owning session", () => {
    let r = withProcess();
    r = createProcess(r, { id: "p2", command: "build", cwd: "/project", ownerSession: "worker" });
    expect(listByOwner(r, "main").map((p) => p.id)).toEqual(["p1"]);
    expect(listByOwner(r, "worker").map((p) => p.id)).toEqual(["p2"]);
  });

  it("removes a process from the registry", () => {
    const r = removeProcess(withProcess(), "p1");
    expect(r.processes.p1).toBeUndefined();
  });
});
