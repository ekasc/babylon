import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { truncateEffect } from "./string.effect";

describe("string.effect", () => {
  it("truncates via Effect", async () => {
    expect(await Effect.runPromise(truncateEffect("hello world", 5))).toBe("hello...");
  });
});
