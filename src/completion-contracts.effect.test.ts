import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { createContractEffect } from "./completion-contracts.effect";

describe("completion-contracts.effect", () => {
  it("creates via Effect", async () => {
    const c = await Effect.runPromise(createContractEffect({ id: "c1", title: "Test", checks: [] }));
    expect(c.id).toBe("c1");
  });
});
