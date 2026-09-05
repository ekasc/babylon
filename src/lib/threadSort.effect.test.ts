import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { sortThreadsEffect } from "./threadSort.effect";

describe("threadSort.effect", () => {
  it("sorts via Effect", async () => {
    const threads = [
      { id: "a", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
      { id: "b", createdAt: "2024-01-03T00:00:00Z", updatedAt: "2024-01-03T00:00:00Z" },
    ];
    const sorted = await Effect.runPromise(sortThreadsEffect(threads as any));
    expect(sorted[0].id).toBe("b");
  });
});
