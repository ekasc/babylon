import * as Effect from "effect/Effect";
import { selectRunnableTasks, type RunnableSelection } from "./scheduler";
import type { ScheduledTaskRegistry } from "./automation";
import type { BackgroundPolicy, EnvironmentSignals } from "./background-policy";
import type { WatchEvent } from "./automation";

export const selectRunnableTasksEffect = (
  tasks: ScheduledTaskRegistry,
  policy: BackgroundPolicy,
  defaultProject: string,
  env: EnvironmentSignals,
  now: number,
  event?: WatchEvent,
): Effect.Effect<RunnableSelection> =>
  Effect.sync(() => selectRunnableTasks(tasks, policy, defaultProject, env, now, event));
