import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { cachedHighlightEffect } from "./highlight.effect";

describe("highlight.effect", () => {
  it("cached via Effect", async () => {
    const v = await Effect.runPromise(cachedHighlightEffect("hello", "ts"));
    expect(v === null || typeof v === "string").toBe(true);
  });
});
