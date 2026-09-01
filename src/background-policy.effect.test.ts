import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { canRunInBackgroundEffect, defaultPolicyEffect } from "./background-policy.effect";

describe("background-policy.effect", () => {
  it("checks via Effect", async () => {
    const policy = await Effect.runPromise(defaultPolicyEffect);
    const res = await Effect.runPromise(
      canRunInBackgroundEffect(policy, "proj", { onBattery: false, asleep: false, activeAgents: 0, currentCost: 0 }),
    );
    expect(res.allowed).toBe(true);
  });
});
