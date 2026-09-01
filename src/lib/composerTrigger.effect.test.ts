import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { detectComposerTriggerEffect } from "./composerTrigger.effect";

describe("composerTrigger.effect", () => {
  it("detects via Effect", async () => {
    expect(await Effect.runPromise(detectComposerTriggerEffect("/hello", 6))).toEqual({
      kind: "slash-command",
      query: "hello",
      rangeStart: 0,
      rangeEnd: 6,
    });
  });
});
