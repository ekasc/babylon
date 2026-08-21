import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerLoop, type SchedulerLoopInput } from "./scheduler-loop";
import { createScheduledTaskRegistry, registerScheduledTask, type ScheduledTask } from "./automation";
import { createAutomationHistory } from "./automation-runner";
import { createAttentionRegistry } from "./attention";
import { defaultPolicy } from "./background-policy";

function task(id: string, intervalMs = 1): ScheduledTask {
  return { id, name: id, enabled: true, trigger: { kind: "interval", intervalMs }, runCount: 0 };
}

function input(overrides: Partial<SchedulerLoopInput> = {}): SchedulerLoopInput & {
  state: { schedule: ReturnType<typeof createScheduledTaskRegistry>; history: ReturnType<typeof createAutomationHistory>; attention: ReturnType<typeof createAttentionRegistry> };
} {
  const state = {
    schedule: createScheduledTaskRegistry(),
    history: createAutomationHistory(),
    attention: createAttentionRegistry(),
  };
  return {
    state,
    getState: () => state,
    setState: (next) => {
      state.schedule = next.schedule;
      state.history = next.history;
      state.attention = next.attention;
    },
    policy: () => defaultPolicy(),
    env: () => ({ onBattery: false, asleep: false, activeAgents: 0, currentCost: 0 }),
    run: () => ({ success: true }),
    ...overrides,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("scheduler loop", () => {
  it("executes due tasks on the interval and commits results", () => {
    const ctx = input();
    ctx.state.schedule = registerScheduledTask(ctx.state.schedule, task("s1"));
    const loop = createSchedulerLoop({ ...ctx, intervalMs: 5 });
    loop.start();
    expect(loop.running()).toBe(true);
    vi.advanceTimersByTime(5);
    expect(ctx.state.history.runs).toHaveLength(1);
    expect(ctx.state.schedule.tasks.s1.runCount).toBe(1);
    loop.stop();
    expect(loop.running()).toBe(false);
  });

  it("does not double-start and stops cleanly", () => {
    const ctx = input();
    ctx.state.schedule = registerScheduledTask(ctx.state.schedule, task("s1"));
    const loop = createSchedulerLoop({ ...ctx, intervalMs: 5 });
    loop.start();
    const t = vi.advanceTimersByTime;
    loop.start();
    t(5);
    loop.stop();
    loop.stop();
    t(500);
    expect(ctx.state.history.runs).toHaveLength(1);
  });

  it("manual tick works without starting the timer", () => {
    const ctx = input();
    ctx.state.schedule = registerScheduledTask(ctx.state.schedule, task("s1"));
    const loop = createSchedulerLoop(ctx);
    loop.tick(1000);
    expect(loop.running()).toBe(false);
    expect(ctx.state.history.runs).toHaveLength(1);
  });

  it("isolates tick failures so the loop keeps running", () => {
    const errors: unknown[] = [];
    let boom = false;
    const ctx = input({ onError: (e) => errors.push(e) });
    ctx.state.schedule = registerScheduledTask(ctx.state.schedule, task("s1"));
    const healthyGetState = ctx.getState;
    ctx.getState = () => {
      if (boom) throw new Error("state exploded");
      return healthyGetState();
    };
    const loop = createSchedulerLoop({ ...ctx, intervalMs: 5 });
    loop.start();
    vi.advanceTimersByTime(5); // healthy tick
    expect(ctx.state.history.runs).toHaveLength(1);
    boom = true;
    vi.advanceTimersByTime(5); // tick throws inside the loop
    expect(errors).toHaveLength(1);
    boom = false;
    vi.advanceTimersByTime(5); // loop still alive
    loop.stop();
    expect(ctx.state.history.runs).toHaveLength(2);
  });

  it("records a failed run instead of crashing when the executor throws", () => {
    const ctx = input({
      run: () => {
        throw new Error("boom");
      },
    });
    ctx.state.schedule = registerScheduledTask(ctx.state.schedule, task("s1"));
    const loop = createSchedulerLoop(ctx);
    loop.tick(1000);
    expect(ctx.state.history.runs).toHaveLength(1);
    expect(ctx.state.history.runs[0]).toMatchObject({ status: "failed", error: "boom" });
    expect(Object.keys(ctx.state.attention.items)).toHaveLength(1);
  });

  it("tolerates timers without unref, as in the browser renderer", () => {
    const ctx = input();
    const original = globalThis.setInterval;
    // Simulate a renderer: setInterval returns a bare handle with no unref.
    (globalThis as { setInterval: unknown }).setInterval = (fn: () => void) => original(fn, 1000);
    try {
      const loop = createSchedulerLoop(ctx);
      expect(() => loop.start()).not.toThrow();
      expect(loop.running()).toBe(true);
      loop.stop();
      expect(loop.running()).toBe(false);
    } finally {
      (globalThis as { setInterval: unknown }).setInterval = original;
    }
  });

  it("respects the background policy gate", () => {
    const ctx = input({ policy: () => ({ ...defaultPolicy(), mode: "never" }) });
    ctx.state.schedule = registerScheduledTask(ctx.state.schedule, task("s1"));
    const loop = createSchedulerLoop(ctx);
    loop.tick(1000);
    expect(ctx.state.history.runs).toHaveLength(0);
  });
});
