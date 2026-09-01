import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { parseSemverEffect, satisfiesSemverRangeEffect } from "./semver.effect";

describe("semver.effect", () => {
  it("parses via Effect", async () => {
    expect(await Effect.runPromise(parseSemverEffect("v1.2.3"))).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });
  it("satisfies via Effect", async () => {
    expect(await Effect.runPromise(satisfiesSemverRangeEffect("1.2.3", ">=1.0.0"))).toBe(true);
  });
});
