import { describe, expect, it } from "vitest";
import { runBackgroundTick } from "./background-controller";
import { createScheduledTaskRegistry, registerScheduledTask } from "./automation";
import { createAutomationHistory } from "./automation-runner";
import { createAttentionRegistry } from "./attention";
import { defaultPolicy } from "./background-policy";

function baseInput() {
  return {
    schedule: createScheduledTaskRegistry(),
    history: createAutomationHistory(),
    attention: createAttentionRegistry(),
    policy: defaultPolicy(),
    defaultProject: "/proj",
    env: { onBattery: false, asleep: false, activeAgents: 0, currentCost: 0 },
    now: 1000,
    run: () => ({ success: true }),
  };
}

describe("background tick", () => {
  it("runs a due task and records it in history", () => {
    const input = baseInput();
    input.schedule = registerScheduledTask(input.schedule, {
      id: "s1",
      name: "deps",
      enabled: true,
      trigger: { kind: "interval", intervalMs: 1 },
      project: "/proj",
      runCount: 0,
    });
    const ran: string[] = [];
    const out = runBackgroundTick({ ...input, run: (t) => (ran.push(t.id), { success: true }) });
    expect(ran).toEqual(["s1"]);
    expect(out.history.runs).toHaveLength(1);
    expect(out.ran).toHaveLength(1);
    expect(out.schedule.tasks.s1.runCount).toBe(1);
    expect(out.blocked).toEqual([]);
  });

  it("reports blocked tasks with reasons and runs nothing", () => {
    const input = baseInput();
    input.policy = { ...input.policy, mode: "never" };
    input.schedule = registerScheduledTask(input.schedule, {
      id: "s1",
      name: "deps",
      enabled: true,
      trigger: { kind: "interval", intervalMs: 1 },
      runCount: 0,
    });
    const out = runBackgroundTick(input);
    expect(out.ran).toEqual([]);
    expect(out.history.runs).toHaveLength(0);
    expect(out.blocked).toEqual([
      { taskId: "s1", reasons: expect.arrayContaining([expect.stringContaining("never")]) },
    ]);
  });

  it("does not re-run a task whose interval has not elapsed", () => {
    let input = baseInput();
    input.schedule = registerScheduledTask(input.schedule, {
      id: "s1",
      name: "deps",
      enabled: true,
      trigger: { kind: "interval", intervalMs: 500 },
      runCount: 0,
    });
    const first = runBackgroundTick(input);
    const second = runBackgroundTick({
      ...input,
      schedule: first.schedule,
      history: first.history,
      attention: first.attention,
      now: 1100,
    });
    expect(second.ran).toEqual([]);
    expect(second.history.runs).toHaveLength(1);
  });
});
