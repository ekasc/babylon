import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { formatTokensEffect } from "./usageFormat.effect";

describe("usageFormat.effect", () => {
  it("formats via Effect", async () => {
    expect(await Effect.runPromise(formatTokensEffect(1500))).toBe("1.50K");
  });
});
