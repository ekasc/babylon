import * as Effect from "effect/Effect";
import { createAutomationHistory, executeDueTasks, type ExecutionInput, type ExecutionOutput, type AutomationHistory } from "./automation-runner";

export const createAutomationHistoryEffect: Effect.Effect<AutomationHistory> = Effect.sync(() =>
  createAutomationHistory(),
);

export const executeDueTasksEffect = (input: ExecutionInput): Effect.Effect<ExecutionOutput> =>
  Effect.sync(() => executeDueTasks(input));
