// Scheduler loop for Phase 8 (Feature 16: Scheduled and Conditional Tasks).
//
// The pure pieces decide which tasks are due and what a run does; this module
// is the clock. It drives the background tick on an interval, commits the new
// registries through a caller-supplied setter (so the loop stays decoupled
// from where state lives), and isolates tick failures so one bad run cannot
// stop the schedule.

import type { ScheduledTaskRegistry } from "./automation";
import {
  executeDueTasks,
  type AutomationHistory,
  type RunnerResult,
} from "./automation-runner";
import type { AttentionRegistry } from "./attention";
import type { CompletionContract } from "./completion-contracts";
import type { BackgroundPolicy, EnvironmentSignals } from "./background-policy";
import { selectRunnableTasks } from "./scheduler";

export const DEFAULT_TICK_INTERVAL_MS = 30_000;

export interface SchedulerLoopState {
  schedule: ScheduledTaskRegistry;
  history: AutomationHistory;
  attention: AttentionRegistry;
}

export interface SchedulerLoopInput {
  /** Read the current schedulable state; called once per tick. */
  getState: () => SchedulerLoopState;
  /** Commit the tick's registry/history/attention updates. */
  setState: (next: SchedulerLoopState) => void;
  contracts?: () => Record<string, CompletionContract> | undefined;
  policy: () => BackgroundPolicy;
  defaultProject?: string;
  env?: () => EnvironmentSignals;
  run: (task: import("./automation").ScheduledTask) => RunnerResult;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

export interface SchedulerLoop {
  start(): void;
  stop(): void;
  running(): boolean;
  /** Run one scheduling pass immediately (also what the timer calls). */
  tick(now?: number): void;
}

export function createSchedulerLoop(input: SchedulerLoopInput): SchedulerLoop {
  // ReturnType works in both Node (Timeout) and the renderer (number).
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = (now = Date.now()): void => {
    // The whole tick is synchronous: nothing can interleave between
    // getState and setState, so callers get a consistent read-commit cycle.
    try {
      const state = input.getState();
      const selection = selectRunnableTasks(
        state.schedule,
        input.policy(),
        input.defaultProject ?? "",
        input.env?.() ?? { onBattery: false, asleep: false, activeAgents: 0, currentCost: 0 },
        now
      );
      const executed = executeDueTasks({
        registry: state.schedule,
        runnable: selection.runnable,
        history: state.history,
        attention: state.attention,
        contracts: input.contracts?.(),
        now,
        run: input.run,
      });
      input.setState({
        schedule: executed.registry,
        history: executed.history,
        attention: executed.attention,
      });
    } catch (err) {
      // A failing tick must never kill the loop or the host process.
      input.onError?.(err);
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => tick(), input.intervalMs ?? DEFAULT_TICK_INTERVAL_MS);
      // Node-only: keeps the timer from holding the process open. The
      // renderer's interval handle is a number with no unref.
      if (typeof (timer as { unref?: unknown }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    running() {
      return timer !== null;
    },
    tick,
  };
}
