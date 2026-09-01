import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { makeSpringEffect } from "./spring.effect";
import { springSnappy } from "./spring";

describe("spring.effect", () => {
  it("creates via Effect", async () => {
    const s = await Effect.runPromise(makeSpringEffect(0, 1, springSnappy, () => {}));
    expect(s.value).toBe(0);
  });
});
