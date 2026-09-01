import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { isDevProxiedPathEffect } from "./devProxy.effect";

describe("devProxy.effect", () => {
  it("checks via Effect", async () => {
    expect(await Effect.runPromise(isDevProxiedPathEffect("/api/foo"))).toBe(true);
    expect(await Effect.runPromise(isDevProxiedPathEffect("/"))).toBe(false);
  });
});
