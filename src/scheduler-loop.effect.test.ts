import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeSchedulerLoop, tickEffect } from "./scheduler-loop.effect";
import { createSchedulerLoop } from "./scheduler-loop";
import { createScheduledTaskRegistry } from "./automation";
import { createAutomationHistory } from "./automation-runner";
import { defaultPolicy } from "./background-policy";

describe("scheduler-loop.effect parity", () => {
  it("tickEffect does same as createSchedulerLoop.tick", async () => {
    const makeState = () => ({
      schedule: createScheduledTaskRegistry(),
      history: createAutomationHistory(),
      attention: { items: {} },
    });
    let state1 = makeState();
    let state2 = makeState();
    const input1 = {
      getState: () => state1,
      setState: (n: typeof state1) => { state1 = n; },
      policy: () => defaultPolicy(),
      run: () => ({ success: false, error: "noop" }),
    };
    const input2 = {
      getState: () => state2,
      setState: (n: typeof state2) => { state2 = n; },
      policy: () => defaultPolicy(),
      run: () => ({ success: false, error: "noop" }),
    };
    const plain = createSchedulerLoop(input1);
    plain.tick(Date.now());
    await Effect.runPromise(tickEffect(input2));
    expect(state1.schedule).toEqual(state2.schedule);
    expect(state1.history).toEqual(state2.history);
  });

  it("makeSchedulerLoop runs via Effect", async () => {
    let state = {
      schedule: createScheduledTaskRegistry(),
      history: createAutomationHistory(),
      attention: { items: {} },
    };
    const input = {
      getState: () => state,
      setState: (n: typeof state) => { state = n; },
      policy: () => defaultPolicy(),
      run: () => ({ success: false, error: "noop" }),
      intervalMs: 100000,
    };
    const program = Effect.gen(function* () {
      const loop = yield* makeSchedulerLoop(input);
      yield* loop.tick;
      yield* Fiber.interrupt(loop.fiber);
    });
    await Effect.runPromise(program);
    expect(state).toBeDefined();
  });
});
