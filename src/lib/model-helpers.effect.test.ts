import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { filterModelsEffect } from "./model-helpers.effect";

describe("model-helpers.effect", () => {
  it("filters via Effect", async () => {
    const models = [
      { provider: "openai", id: "gpt-4", name: "GPT-4" },
      { provider: "anthropic", id: "claude", name: "Claude" },
    ];
    expect(await Effect.runPromise(filterModelsEffect(models, "gpt", "all"))).toHaveLength(1);
  });
});
