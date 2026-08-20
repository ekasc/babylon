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
  /** Project this task runs against (for per-project background policy). */
  project?: string;
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
  // Copy the trigger so a later mutation of the caller's object cannot change
  // the stored schedule.
  return { tasks: { ...registry.tasks, [task.id]: { ...task, trigger: { ...task.trigger } } } };
}

export function setScheduledTaskEnabled(
  registry: ScheduledTaskRegistry,
  id: string,
  enabled: boolean
): ScheduledTaskRegistry {
  const existing = registry.tasks[id];
  if (!existing || existing.enabled === enabled) return registry;
  return { tasks: { ...registry.tasks, [id]: { ...existing, trigger: { ...existing.trigger }, enabled } } };
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
    tasks: {
      ...registry.tasks,
      [id]: { ...existing, trigger: { ...existing.trigger }, lastRunAt: at, runCount: existing.runCount + 1 },
    },
  };
}

function dailyInstant(now: number, hour: number, minute: number): number {
  // Resolve the daily time in UTC so scheduling is timezone-stable: the hour and
  // minute are interpreted in UTC, not the host's local zone.
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0);
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
      if (
        h === undefined ||
        m === undefined ||
        !Number.isInteger(h) ||
        !Number.isInteger(m) ||
        h < 0 ||
        h > 23 ||
        m < 0 ||
        m > 59
      )
        return false;
      const instant = dailyInstant(now, h, m);
      if (now < instant) return false; // not time yet today (UTC)
      if (lastRunAt === undefined) return true;
      // Due when it has not already run at/after today's instant.
      return lastRunAt < instant;
    }
    case "file_watch": {
      if (!event || event.type !== "file_change") return false;
      if (trigger.path === undefined) return true; // watch any file
      if (event.path === undefined) return false;
      const watchRoot = trigger.path.endsWith("/") ? trigger.path.slice(0, -1) : trigger.path;
      // Exact file match, or any change at or under the watched directory
      // (including a trailing-slash or root path).
      return event.path === trigger.path || event.path.startsWith(watchRoot + "/");
    }
    case "branch_watch": {
      if (!event || event.type !== "branch_change") return false;
      if (trigger.branch === undefined) return true; // watch any branch
      return event.branch === trigger.branch;
    }
    default:
      return false;
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
