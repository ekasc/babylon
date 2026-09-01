import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { projectColorEffect } from "./colors.effect";

describe("colors.effect", () => {
  it("colors via Effect", async () => {
    expect(await Effect.runPromise(projectColorEffect("/a/b"))).toBe(await Effect.runPromise(projectColorEffect("/a/b")));
  });
});
