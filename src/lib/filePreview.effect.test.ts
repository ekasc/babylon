import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { isWorkspacePreviewEntryPathEffect } from "./filePreview.effect";

describe("filePreview.effect", () => {
  it("detects via Effect", async () => {
    expect(await Effect.runPromise(isWorkspacePreviewEntryPathEffect("a.html"))).toBe(true);
    expect(await Effect.runPromise(isWorkspacePreviewEntryPathEffect("c.txt"))).toBe(false);
  });
});
