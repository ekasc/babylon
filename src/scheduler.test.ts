import { describe, expect, it } from "vitest";
import { defaultPolicy, type BackgroundPolicy, type EnvironmentSignals } from "./background-policy";
import { createScheduledTaskRegistry, registerScheduledTask, type ScheduledTask, type ScheduledTaskRegistry } from "./automation";
import { selectRunnableTasks } from "./scheduler";

const NOW = Date.UTC(2024, 5, 1, 9, 5, 0);

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "s1",
    name: "Dep check",
    enabled: true,
    trigger: { kind: "interval", intervalMs: 1 },
    runCount: 0,
    ...over,
  };
}

function signals(over: Partial<EnvironmentSignals> = {}): EnvironmentSignals {
  return { onBattery: false, asleep: false, activeAgents: 0, currentCost: 0, ...over };
}

describe("scheduler decision engine", () => {
  it("selects a due task that the policy permits", () => {
    let r: ScheduledTaskRegistry = createScheduledTaskRegistry();
    r = registerScheduledTask(r, task());
    const sel = selectRunnableTasks(r, defaultPolicy(), "p", signals(), NOW);
    expect(sel.runnable.map((t) => t.id)).toEqual(["s1"]);
    expect(sel.blocked).toHaveLength(0);
  });

  it("blocks a due task when the policy forbids background work", () => {
    let r = createScheduledTaskRegistry();
    r = registerScheduledTask(r, task());
    const policy: BackgroundPolicy = { ...defaultPolicy(), mode: "never" };
    const sel = selectRunnableTasks(r, policy, "p", signals(), NOW);
    expect(sel.runnable).toHaveLength(0);
    expect(sel.blocked[0].reasons.join()).toMatch(/never/);
  });

  it("blocks a due task when on battery and policy pauses on battery", () => {
    let r = createScheduledTaskRegistry();
    r = registerScheduledTask(r, task());
    const sel = selectRunnableTasks(r, defaultPolicy(), "p", signals({ onBattery: true }), NOW);
    expect(sel.runnable).toHaveLength(0);
    expect(sel.blocked).toHaveLength(1);
  });

  it("applies per-project policy using the task's project tag", () => {
    let r = createScheduledTaskRegistry();
    r = registerScheduledTask(r, task({ id: "a", project: "secret" }));
    const policy: BackgroundPolicy = {
      ...defaultPolicy(),
      perProjectPermission: { secret: false },
    };
    const sel = selectRunnableTasks(r, policy, "default", signals(), NOW);
    expect(sel.runnable).toHaveLength(0);
    expect(sel.blocked[0].task.id).toBe("a");
  });

  it("ignores non-due and disabled tasks", () => {
    let r = createScheduledTaskRegistry();
    r = registerScheduledTask(r, task({ id: "a", trigger: { kind: "interval", intervalMs: 1 } }));
    r = registerScheduledTask(r, task({ id: "b", enabled: false, trigger: { kind: "interval", intervalMs: 1 } }));
    r = registerScheduledTask(r, task({ id: "c", trigger: { kind: "interval", intervalMs: 100000 }, lastRunAt: NOW }));
    const sel = selectRunnableTasks(r, defaultPolicy(), "p", signals(), NOW);
    expect(sel.runnable.map((t) => t.id)).toEqual(["a"]);
  });
});
