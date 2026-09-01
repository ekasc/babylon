import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { renderPlainDiffEffect } from "./diff-highlight.effect";

describe("diff-highlight.effect", () => {
  it("renders via Effect", async () => {
    const rows = await Effect.runPromise(renderPlainDiffEffect("@@ -1,1 +1,1 @@\n-old\n+new"));
    expect(rows.length).toBeGreaterThan(0);
  });
});
