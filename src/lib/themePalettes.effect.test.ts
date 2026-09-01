import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { isReservedThemeIdEffect } from "./themePalettes.effect";

describe("themePalettes.effect", () => {
  it("checks via Effect", async () => {
    expect(await Effect.runPromise(isReservedThemeIdEffect("system"))).toBe(true);
    expect(await Effect.runPromise(isReservedThemeIdEffect("my-custom"))).toBe(false);
  });
});
