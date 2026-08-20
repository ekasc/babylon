import { describe, expect, it } from "vitest";
import {
  createScheduledTaskRegistry,
  evaluateTrigger,
  listDueTasks,
  recordRun,
  registerScheduledTask,
  removeScheduledTask,
  setScheduledTaskEnabled,
  type ScheduledTask,
  type ScheduledTaskRegistry,
  type Trigger,
  type WatchEvent,
} from "./automation";

const NOW = new Date(2024, 5, 1, 9, 5, 0).getTime();
const TODAY_INSTANT = new Date(2024, 5, 1, 9, 0, 0).getTime();
const YESTERDAY_INSTANT = new Date(2024, 5, 0, 9, 0, 0).getTime();

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return { id: "s1", name: "Dep check", enabled: true, trigger: { kind: "interval", intervalMs: 1000 }, runCount: 0, ...over };
}

describe("automation triggers", () => {
  it("interval fires on first run and after the interval elapses", () => {
    const t: Trigger = { kind: "interval", intervalMs: 1000 };
    expect(evaluateTrigger(t, undefined, NOW)).toBe(true);
    expect(evaluateTrigger(t, NOW - 500, NOW)).toBe(false);
    expect(evaluateTrigger(t, NOW - 1500, NOW)).toBe(true);
  });

  it("interval never fires with a non-positive value", () => {
    expect(evaluateTrigger({ kind: "interval", intervalMs: 0 }, undefined, NOW)).toBe(false);
  });

  it("daily fires once per day at the scheduled time", () => {
    const t: Trigger = { kind: "daily", hour: 9, minute: 0 };
    expect(evaluateTrigger(t, undefined, NOW)).toBe(true); // never run, time passed
    expect(evaluateTrigger(t, TODAY_INSTANT, NOW)).toBe(false); // already ran today
    expect(evaluateTrigger(t, YESTERDAY_INSTANT, NOW)).toBe(true); // ran yesterday
    expect(evaluateTrigger(t, NOW, new Date(2024, 5, 1, 8, 55, 0).getTime())).toBe(false); // too early
    expect(evaluateTrigger({ kind: "daily", hour: 25, minute: 0 }, undefined, NOW)).toBe(false);
  });

  it("file_watch fires on a matching change event", () => {
    const t: Trigger = { kind: "file_watch", path: "/src" };
    const hit: WatchEvent = { type: "file_change", path: "/src/a.ts" };
    const miss: WatchEvent = { type: "file_change", path: "/other/b.ts" };
    const branch: WatchEvent = { type: "branch_change", branch: "main" };
    expect(evaluateTrigger(t, undefined, NOW, hit)).toBe(true);
    expect(evaluateTrigger(t, undefined, NOW, miss)).toBe(false);
    expect(evaluateTrigger(t, undefined, NOW, branch)).toBe(false);
    expect(evaluateTrigger({ kind: "file_watch" }, undefined, NOW, hit)).toBe(true); // any file
  });

  it("branch_watch fires on a matching branch event", () => {
    const t: Trigger = { kind: "branch_watch", branch: "main" };
    expect(evaluateTrigger(t, undefined, NOW, { type: "branch_change", branch: "main" })).toBe(true);
    expect(evaluateTrigger(t, undefined, NOW, { type: "branch_change", branch: "dev" })).toBe(false);
    expect(evaluateTrigger(t, undefined, NOW, { type: "file_change" })).toBe(false);
  });
});

describe("scheduled task registry", () => {
  it("registers without clobbering", () => {
    let r: ScheduledTaskRegistry = createScheduledTaskRegistry();
    r = registerScheduledTask(r, task());
    expect(r.tasks.s1.enabled).toBe(true);
    r = registerScheduledTask(r, task({ enabled: false }));
    expect(r.tasks.s1.enabled).toBe(true);
  });

  it("toggles enabled and is a no-op on match", () => {
    let r = registerScheduledTask(createScheduledTaskRegistry(), task());
    r = setScheduledTaskEnabled(r, "s1", false);
    expect(r.tasks.s1.enabled).toBe(false);
    expect(setScheduledTaskEnabled(r, "s1", false)).toBe(r);
  });

  it("removes a task (no-op when absent)", () => {
    const r = registerScheduledTask(createScheduledTaskRegistry(), task());
    const removed = removeScheduledTask(r, "s1");
    expect(removed.tasks.s1).toBeUndefined();
    expect(removeScheduledTask(removed, "s1")).toBe(removed);
  });

  it("records a run and increments count", () => {
    let r = registerScheduledTask(createScheduledTaskRegistry(), task());
    r = recordRun(r, "s1", 123);
    expect(r.tasks.s1.lastRunAt).toBe(123);
    expect(r.tasks.s1.runCount).toBe(1);
  });

  it("omits disabled tasks from due list", () => {
    let r = createScheduledTaskRegistry();
    r = registerScheduledTask(r, task({ id: "a", trigger: { kind: "interval", intervalMs: 1 } }));
    r = registerScheduledTask(r, task({ id: "b", enabled: false, trigger: { kind: "interval", intervalMs: 1 } }));
    expect(listDueTasks(r, NOW).map((t) => t.id)).toEqual(["a"]);
  });
});
