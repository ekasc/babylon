import { describe, expect, it } from "vitest";
import {
  detectComposerTrigger,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from "./composerTrigger";

describe("detectComposerTrigger", () => {
  it("detects slash-command at start", () => {
    expect(detectComposerTrigger("/hello", 6)).toEqual({
      kind: "slash-command",
      query: "hello",
      rangeStart: 0,
      rangeEnd: 6,
    });
  });

  it("detects slash-command after newline", () => {
    expect(detectComposerTrigger("hi\n/model", 9)).toEqual({
      kind: "slash-model",
      query: "",
      rangeStart: 3,
      rangeEnd: 9,
    });
  });

  it("detects slash-model with query", () => {
    expect(detectComposerTrigger("/model gpt-4", 12)).toEqual({
      kind: "slash-model",
      query: "gpt-4",
      rangeStart: 0,
      rangeEnd: 12,
    });
  });

  it("detects skill trigger", () => {
    expect(detectComposerTrigger("run $build", 10)).toEqual({
      kind: "skill",
      query: "build",
      rangeStart: 4,
      rangeEnd: 10,
    });
  });

  it("detects path trigger", () => {
    const text = "see @src/app.ts";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "path",
      query: "src/app.ts",
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it("returns null when no trigger", () => {
    expect(detectComposerTrigger("hello world", 5)).toBeNull();
  });

  it("clamps cursor", () => {
    expect(detectComposerTrigger("/hi", 100)).toEqual({
      kind: "slash-command",
      query: "hi",
      rangeStart: 0,
      rangeEnd: 3,
    });
  });
});

describe("serialize helpers", () => {
  it("serializes simple path without quotes", () => {
    expect(serializeComposerMentionPath("src/app.ts")).toBe("src/app.ts");
  });

  it("quotes path with spaces", () => {
    expect(serializeComposerMentionPath("my file.ts")).toBe('"my file.ts"');
  });

  it("serializes file link", () => {
    expect(serializeComposerFileLink("src/app.ts")).toBe("[app.ts](src/app.ts)");
  });
});

describe("replaceTextRange", () => {
  it("replaces range and moves cursor", () => {
    expect(replaceTextRange("hello @src", 6, 10, "@src/app.ts")).toEqual({
      text: "hello @src/app.ts",
      cursor: 17,
    });
  });
});

describe("parseStandaloneComposerSlashCommand", () => {
  it("parses /plan", () => {
    expect(parseStandaloneComposerSlashCommand("/plan")).toBe("plan");
  });

  it("returns null for unknown", () => {
    expect(parseStandaloneComposerSlashCommand("/unknown")).toBeNull();
  });
});
