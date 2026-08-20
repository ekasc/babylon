// Background execution tick for Phase 6 (Feature 14).
//
// Composes the scheduler's policy gate with the automation executor into one
// pure step the daemon can run on a timer or on demand. A task runs only when
// its trigger is due AND the background policy permits it; every executed run
// lands in history, and failures land in the attention inbox (the executor's
// contract). Returns the new registries plus what happened so callers can
// broadcast events without re-deriving state.

import type { ScheduledTaskRegistry } from "./automation";
import {
  executeDueTasks,
  type AutomationHistory,
  type AutomationRun,
  type RunnerResult,
} from "./automation-runner";
import type { AttentionRegistry } from "./attention";
import type { CompletionContract } from "./completion-contracts";
import type { BackgroundPolicy, EnvironmentSignals } from "./background-policy";
import { selectRunnableTasks } from "./scheduler";

export interface BackgroundTickInput {
  schedule: ScheduledTaskRegistry;
  history: AutomationHistory;
  attention: AttentionRegistry;
  contracts?: Record<string, CompletionContract>;
  policy: BackgroundPolicy;
  defaultProject: string;
  env: EnvironmentSignals;
  now: number;
  run: (task: import("./automation").ScheduledTask) => RunnerResult;
}

export interface BackgroundTickOutput {
  schedule: ScheduledTaskRegistry;
  history: AutomationHistory;
  attention: AttentionRegistry;
  /** Runs recorded by this tick, in order. */
  ran: AutomationRun[];
  /** Due tasks the policy blocked, with reasons, for UI explanation. */
  blocked: { taskId: string; reasons: string[] }[];
}

export function runBackgroundTick(input: BackgroundTickInput): BackgroundTickOutput {
  const selection = selectRunnableTasks(
    input.schedule,
    input.policy,
    input.defaultProject,
    input.env,
    input.now
  );
  const previousRuns = input.history.runs.length;
  const executed = executeDueTasks({
    registry: input.schedule,
    runnable: selection.runnable,
    history: input.history,
    attention: input.attention,
    contracts: input.contracts,
    now: input.now,
    run: input.run,
  });
  return {
    schedule: executed.registry,
    history: executed.history,
    attention: executed.attention,
    ran: executed.history.runs.slice(previousRuns),
    blocked: selection.blocked.map((b) => ({ taskId: b.task.id, reasons: b.reasons })),
  };
}
