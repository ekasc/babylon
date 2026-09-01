import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { addAttentionEffect, createAttentionRegistryEffect } from "./attention.effect";

describe("attention.effect", () => {
  it("adds via Effect", async () => {
    const reg = await Effect.runPromise(createAttentionRegistryEffect);
    const next = await Effect.runPromise(
      addAttentionEffect(reg, { id: "a", type: "permission", title: "t", createdAt: 0, resolved: false }),
    );
    expect(next.items["a"]).toBeDefined();
  });
});
