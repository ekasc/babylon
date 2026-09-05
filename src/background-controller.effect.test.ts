import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { runBackgroundTickEffect } from "./background-controller.effect";
import { createScheduledTaskRegistry } from "./automation";
import { createAutomationHistory } from "./automation-runner";
import { defaultPolicy } from "./background-policy";

describe("background-controller.effect", () => {
  it("wraps tick", async () => {
    const out = await Effect.runPromise(
      runBackgroundTickEffect({
        schedule: createScheduledTaskRegistry(),
        history: createAutomationHistory(),
        attention: { items: {} },
        policy: defaultPolicy(),
        defaultProject: "",
        env: { onBattery: false, asleep: false, activeAgents: 0, currentCost: 0 },
        now: Date.now(),
        run: () => ({ success: false, error: "noop" }),
      }),
    );
    expect(out.ran).toEqual([]);
  });
});
