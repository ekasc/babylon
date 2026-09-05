import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { createRegistryEffect } from "./process-model.effect";

describe("process-model.effect", () => {
  it("creates via Effect", async () => {
    const r = await Effect.runPromise(createRegistryEffect);
    expect(r).toBeDefined();
  });
});
