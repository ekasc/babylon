import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { normalizeProjectPathForComparisonEffect, normalizeProjectPathForDispatchEffect } from "./path.effect";

describe("path.effect", () => {
  it("dispatch effect", async () => {
    expect(await Effect.runPromise(normalizeProjectPathForDispatchEffect("/foo/bar/"))).toBe("/foo/bar");
  });
  it("comparison effect", async () => {
    expect(await Effect.runPromise(normalizeProjectPathForComparisonEffect("C:\\Foo\\Bar"))).toBe("c:\\foo\\bar");
  });
});
