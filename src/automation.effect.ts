import * as Effect from "effect/Effect";
import {
  createScheduledTaskRegistry,
  listDueTasks,
  registerScheduledTask,
  type ScheduledTask,
  type ScheduledTaskRegistry,
  type WatchEvent,
} from "./automation";

export const createScheduledTaskRegistryEffect: Effect.Effect<ScheduledTaskRegistry> = Effect.sync(() =>
  createScheduledTaskRegistry(),
);

export const registerScheduledTaskEffect = (
  registry: ScheduledTaskRegistry,
  task: ScheduledTask,
): Effect.Effect<ScheduledTaskRegistry> => Effect.sync(() => registerScheduledTask(registry, task));

export const listDueTasksEffect = (
  tasks: ScheduledTaskRegistry,
  now: number,
  event?: WatchEvent,
): Effect.Effect<ScheduledTask[]> => Effect.sync(() => listDueTasks(tasks, now, event));
