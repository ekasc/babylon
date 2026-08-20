// Automation for Phase 8 (Feature 16: Scheduled and Conditional Tasks).
//
// After background execution is reliable, Babylon tasks can run without an open
// foreground session. This module models scheduled/conditional triggers and an
// evaluator that decides, given the current time and an optional watch event,
// which tasks are due. The registry is pure and testable; the scheduler and
// executor build on top.

import { makeId } from "./runtime";

export type TriggerKind = "interval" | "daily" | "file_watch" | "branch_watch";

export interface Trigger {
  kind: TriggerKind;
  /** interval: milliseconds between runs (must be > 0). */
  intervalMs?: number;
  /** daily: wall-clock hour (0-23) and minute (0-59). */
  hour?: number;
  minute?: number;
  /** file_watch: path prefix to watch. */
  path?: string;
  /** branch_watch: branch name to watch. */
  branch?: string;
}

export interface WatchEvent {
  type: "file_change" | "branch_change";
  path?: string;
  branch?: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  lastRunAt?: number;
  runCount: number;
}

export interface ScheduledTaskRegistry {
  tasks: Record<string, ScheduledTask>;
}

export function createScheduledTaskRegistry(): ScheduledTaskRegistry {
  return { tasks: {} };
}

export function registerScheduledTask(
  registry: ScheduledTaskRegistry,
  task: ScheduledTask
): ScheduledTaskRegistry {
  if (registry.tasks[task.id]) return registry; // no clobber
  return { tasks: { ...registry.tasks, [task.id]: { ...task } } };
}

export function setScheduledTaskEnabled(
  registry: ScheduledTaskRegistry,
  id: string,
  enabled: boolean
): ScheduledTaskRegistry {
  const existing = registry.tasks[id];
  if (!existing || existing.enabled === enabled) return registry;
  return { tasks: { ...registry.tasks, [id]: { ...existing, enabled } } };
}

export function removeScheduledTask(registry: ScheduledTaskRegistry, id: string): ScheduledTaskRegistry {
  if (!registry.tasks[id]) return registry;
  const next = { ...registry.tasks };
  delete next[id];
  return { tasks: next };
}

export function recordRun(registry: ScheduledTaskRegistry, id: string, at: number): ScheduledTaskRegistry {
  const existing = registry.tasks[id];
  if (!existing) return registry;
  return {
    tasks: { ...registry.tasks, [id]: { ...existing, lastRunAt: at, runCount: existing.runCount + 1 } },
  };
}

function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function dailyInstant(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/**
 * Pure trigger evaluation. Returns whether the trigger fires at `now` given the
 * last run time and an optional watch event. Invalid trigger configurations
 * (e.g. non-positive interval, out-of-range daily time) never fire.
 */
export function evaluateTrigger(
  trigger: Trigger,
  lastRunAt: number | undefined,
  now: number,
  event?: WatchEvent
): boolean {
  switch (trigger.kind) {
    case "interval": {
      const ms = trigger.intervalMs;
      if (!ms || ms <= 0) return false;
      if (lastRunAt === undefined) return true;
      return now - lastRunAt >= ms;
    }
    case "daily": {
      const h = trigger.hour;
      const m = trigger.minute;
      if (h === undefined || m === undefined || h < 0 || h > 23 || m < 0 || m > 59) return false;
      const instant = dailyInstant(now, h, m);
      if (now < instant) return false; // not time yet today
      if (lastRunAt === undefined) return true;
      // Due only if it has not already run at/after today's instant.
      return lastRunAt < instant && !sameLocalDay(lastRunAt, instant);
    }
    case "file_watch": {
      if (!event || event.type !== "file_change") return false;
      if (trigger.path === undefined) return true; // watch any file
      return (
        event.path !== undefined &&
        (event.path === trigger.path || event.path.startsWith(trigger.path + "/"))
      );
    }
    case "branch_watch": {
      if (!event || event.type !== "branch_change") return false;
      if (trigger.branch === undefined) return true; // watch any branch
      return event.branch === trigger.branch;
    }
  }
}

/** Enabled tasks whose trigger fires at `now` given `event`. */
export function listDueTasks(
  registry: ScheduledTaskRegistry,
  now: number,
  event?: WatchEvent
): ScheduledTask[] {
  return Object.values(registry.tasks).filter(
    (t) => t.enabled && evaluateTrigger(t.trigger, t.lastRunAt, now, event)
  );
}

export function newScheduledTaskId(): string {
  return makeId("sched");
}
