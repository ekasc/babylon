import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { pinOrderKeyBetweenEffect } from "./pinOrder.effect";

describe("pinOrder.effect", () => {
  it("between via Effect", async () => {
    const mid = await Effect.runPromise(pinOrderKeyBetweenEffect("m", "o"));
    expect(mid).not.toBeNull();
  });
});
