import { describe, expect, it } from "vitest";
import { collectComposerInlineTokens } from "./composerInlineTokens";

describe("collectComposerInlineTokens", () => {
  it("collects @ mention", () => {
    expect(collectComposerInlineTokens("see @hello ")).toEqual([
      { type: "mention", value: "hello", source: "@hello", start: 4, end: 10 },
    ]);
  });
  it("collects $ skill", () => {
    expect(collectComposerInlineTokens("run $build ")).toEqual([
      { type: "skill", value: "build", source: "$build", start: 4, end: 10 },
    ]);
  });
  it("collects file link", () => {
    expect(collectComposerInlineTokens("see [app.ts](src/app.ts) ")).toEqual([
      { type: "mention", value: "src/app.ts", source: "[app.ts](src/app.ts)", start: 4, end: 24 },
    ]);
  });
  it("preserves trailing token", () => {
    const prev = collectComposerInlineTokens("hi @src/app.ts");
    expect(collectComposerInlineTokens("hi @src/app.ts", { preserveTrailingFrom: prev })).toEqual(prev);
  });
  it("ignores scoped package", () => {
    expect(collectComposerInlineTokens("use @scope/package ")).toEqual([]);
  });
});
