import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { createAutomationHistoryEffect, executeDueTasksEffect } from "./automation-runner.effect";
import { createScheduledTaskRegistry } from "./automation";

describe("automation-runner.effect", () => {
  it("wraps via Effect", async () => {
    const history = await Effect.runPromise(createAutomationHistoryEffect);
    const out = await Effect.runPromise(
      executeDueTasksEffect({
        registry: createScheduledTaskRegistry(),
        runnable: [],
        history,
        attention: { items: {} },
        now: Date.now(),
        run: () => ({ success: false, error: "noop" }),
      }),
    );
    expect(out.history).toBeDefined();
  });
});
