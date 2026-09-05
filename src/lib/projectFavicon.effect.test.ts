import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { isProjectFaviconFallbackUrlEffect } from "./projectFavicon.effect";

describe("projectFavicon.effect", () => {
  it("detects via Effect", async () => {
    expect(await Effect.runPromise(isProjectFaviconFallbackUrlEffect(null))).toBe(false);
  });
});
