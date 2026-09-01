import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { nextTerminalIdEffect } from "./terminalLabels.effect";

describe("terminalLabels.effect", () => {
  it("allocates via Effect", async () => {
    expect(await Effect.runPromise(nextTerminalIdEffect(["term-1", "term-3"]))).toBe("term-2");
  });
});
