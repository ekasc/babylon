import * as Effect from "effect/Effect";
import { addTerminal, allocateTerminal, createTask, type Task, type TaskRegistry } from "./tasks";

export const addTerminalEffect = (registry: TaskRegistry, id: string, terminalId: string): Effect.Effect<TaskRegistry> =>
  Effect.sync(() => addTerminal(registry, id, terminalId));

export const allocateTerminalEffect = (
  registry: TaskRegistry,
  id: string,
): Effect.Effect<{ registry: TaskRegistry; terminalId: string } | null> =>
  Effect.sync(() => allocateTerminal(registry, id));

export const createTaskEffect = (params: Parameters<typeof createTask>[0]): Effect.Effect<Task> =>
  Effect.sync(() => createTask(params));
