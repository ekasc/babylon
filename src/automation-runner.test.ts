import { describe, expect, it } from "vitest";
import { createAttentionRegistry, listAttention } from "./attention";
import { createScheduledTaskRegistry, registerScheduledTask, type ScheduledTask } from "./automation";
import { createAutomationHistory, executeDueTasks } from "./automation-runner";
import { createContract } from "./completion-contracts";

function task(id: string, name: string): ScheduledTask {
  return { id, name, enabled: true, trigger: { kind: "interval", intervalMs: 1000 }, runCount: 0 };
}

describe("automation executor", () => {
  it("records success and does not create attention", () => {
    const registry = registerScheduledTask(createScheduledTaskRegistry(), task("t1", "health check"));
    const history = createAutomationHistory();
    const attention = createAttentionRegistry();
    const out = executeDueTasks({
      registry,
      runnable: [task("t1", "health check")],
      history,
      attention,
      now: 1000,
      run: () => ({ success: true }),
    });
    expect(out.history.runs).toHaveLength(1);
    expect(out.history.runs[0].status).toBe("succeeded");
    expect(out.history.runs[0].taskName).toBe("health check");
    expect(listAttention(out.attention)).toHaveLength(0);
    expect(out.registry.tasks.t1.runCount).toBe(1);
    expect(out.registry.tasks.t1.lastRunAt).toBe(1000);
  });

  it("records failure, creates inspectable history, and enters attention inbox", () => {
    const registry = registerScheduledTask(createScheduledTaskRegistry(), task("t1", "health check"));
    const history = createAutomationHistory();
    const attention = createAttentionRegistry();
    const out = executeDueTasks({
      registry,
      runnable: [task("t1", "health check")],
      history,
      attention,
      now: 2000,
      run: () => ({ success: false, error: "tests failed" }),
    });
    expect(out.history.runs[0].status).toBe("failed");
    expect(out.history.runs[0].error).toBe("tests failed");
    expect(listAttention(out.attention)).toHaveLength(1);
    expect(listAttention(out.attention)[0].title).toContain("health check");
  });

  it("reuses completion contracts: failed contract marks run as failed even when runner succeeded", () => {
    const registry = registerScheduledTask(createScheduledTaskRegistry(), task("t1", "lint"));
    const contract = createContract({
      id: "t1",
      title: "done",
      checks: [{ kind: "typecheck", label: "typecheck", required: true }],
    });
    const out = executeDueTasks({
      registry,
      runnable: [task("t1", "lint")],
      history: createAutomationHistory(),
      attention: createAttentionRegistry(),
      contracts: { t1: contract },
      now: 3000,
      run: () => ({ success: true, checkResults: [{ kind: "typecheck", passed: false }] }),
    });
    expect(out.history.runs[0].status).toBe("failed");
    expect(out.history.runs[0].contractPassed).toBe(false);
    expect(listAttention(out.attention)).toHaveLength(1);
  });

  it("passes when contract checks all succeed", () => {
    const registry = registerScheduledTask(createScheduledTaskRegistry(), task("t1", "lint"));
    const contract = createContract({
      id: "t1",
      title: "done",
      checks: [{ kind: "lint", label: "lint", required: true }],
    });
    const out = executeDueTasks({
      registry,
      runnable: [task("t1", "lint")],
      history: createAutomationHistory(),
      attention: createAttentionRegistry(),
      contracts: { t1: contract },
      now: 3000,
      run: () => ({ success: true, checkResults: [{ kind: "lint", passed: true }] }),
    });
    expect(out.history.runs[0].status).toBe("succeeded");
    expect(out.history.runs[0].contractPassed).toBe(true);
    expect(listAttention(out.attention)).toHaveLength(0);
  });

  it("is no-op when runnable is empty and preserves history", () => {
    const history = createAutomationHistory();
    const out = executeDueTasks({
      registry: createScheduledTaskRegistry(),
      runnable: [],
      history,
      attention: createAttentionRegistry(),
      now: 4000,
      run: () => ({ success: true }),
    });
    expect(out.history.runs).toHaveLength(0);
  });

  it("does not mutate input registries", () => {
    const registry = registerScheduledTask(createScheduledTaskRegistry(), task("t1", "x"));
    const history = createAutomationHistory();
    const attention = createAttentionRegistry();
    const out = executeDueTasks({
      registry,
      runnable: [task("t1", "x")],
      history,
      attention,
      now: 5000,
      run: () => ({ success: true }),
    });
    expect(registry.tasks.t1.runCount).toBe(0);
    expect(history.runs).toHaveLength(0);
    expect(listAttention(attention)).toHaveLength(0);
    expect(out.history.runs).toHaveLength(1);
  });
});
