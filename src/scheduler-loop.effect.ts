import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Fiber from "effect/Fiber";
import * as Duration from "effect/Duration";
import type { ScheduledTaskRegistry } from "./automation";
import { executeDueTasks, type AutomationHistory, type RunnerResult } from "./automation-runner";
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
  getState: () => SchedulerLoopState;
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
  readonly fiber: Fiber.Fiber<void, unknown>;
  readonly tick: Effect.Effect<void>;
}

export const makeSchedulerLoop = (input: SchedulerLoopInput) =>
  Effect.gen(function* () {
    const tick = Effect.sync(() => {
      try {
        const state = input.getState();
        const selection = selectRunnableTasks(
          state.schedule,
          input.policy(),
          input.defaultProject ?? "",
          input.env?.() ?? { onBattery: false, asleep: false, activeAgents: 0, currentCost: 0 },
          Date.now(),
        );
        const executed = executeDueTasks({
          registry: state.schedule,
          runnable: selection.runnable,
          history: state.history,
          attention: state.attention,
          contracts: input.contracts?.(),
          now: Date.now(),
          run: input.run,
        });
        input.setState({ schedule: executed.registry, history: executed.history, attention: executed.attention });
      } catch (err) {
        input.onError?.(err);
      }
    });

    const policy = Schedule.spaced(Duration.millis(input.intervalMs ?? DEFAULT_TICK_INTERVAL_MS));
    const fiber = yield* Effect.repeat(tick, policy).pipe(Effect.fork);

    return {
      fiber,
      tick,
    } as SchedulerLoop;
  });

export const tickEffect = (input: SchedulerLoopInput): Effect.Effect<void> =>
  Effect.sync(() => {
    const state = input.getState();
    const selection = selectRunnableTasks(
      state.schedule,
      input.policy(),
      input.defaultProject ?? "",
      input.env?.() ?? { onBattery: false, asleep: false, activeAgents: 0, currentCost: 0 },
      Date.now(),
    );
    const executed = executeDueTasks({
      registry: state.schedule,
      runnable: selection.runnable,
      history: state.history,
      attention: state.attention,
      contracts: input.contracts?.(),
      now: Date.now(),
      run: input.run,
    });
    input.setState({ schedule: executed.registry, history: executed.history, attention: executed.attention });
  });
