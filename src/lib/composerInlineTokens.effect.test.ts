import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { collectComposerInlineTokensEffect } from "./composerInlineTokens.effect";

describe("composerInlineTokens.effect", () => {
  it("collects via Effect", async () => {
    expect(await Effect.runPromise(collectComposerInlineTokensEffect("see @hello "))).toEqual([
      { type: "mention", value: "hello", source: "@hello", start: 4, end: 10 },
    ]);
  });
});
