import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { selectRunnableTasksEffect } from "./scheduler.effect";
import { createScheduledTaskRegistry } from "./automation";
import { defaultPolicy } from "./background-policy";

describe("scheduler.effect", () => {
  it("selects via Effect", async () => {
    const r = await Effect.runPromise(
      selectRunnableTasksEffect(createScheduledTaskRegistry(), defaultPolicy(), "", { onBattery: false, asleep: false, activeAgents: 0, currentCost: 0 }, Date.now()),
    );
    expect(r.runnable).toEqual([]);
  });
});
