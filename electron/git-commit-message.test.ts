import { describe, expect, it } from "vitest";
import { buildGitCommitPrompt, extractModelText, parseGeneratedCommitMessage } from "./git-commit-message";
import type { PreparedCommitContext } from "./git";

const context: PreparedCommitContext = {
  branch: "main",
  stagedSummary: "M\tsrc/file.ts",
  stagedPatch: "+const answer = 42;",
  truncatedPatch: false,
  recentSubjects: "Fix session reload\nAdd Git sidebar",
  fileCount: 1,
  insertions: 1,
  deletions: 0,
  areas: ["src"],
  requiresBody: false,
  stagedBefore: [],
};

describe("git commit message generation", () => {
  it("builds a structured Unslop prompt with staged context", () => {
    const prompt = buildGitCommitPrompt(context, "Use a direct tone.");
    expect(prompt).toContain("Return JSON with exactly two string keys");
    expect(prompt).toContain("apply Unslop");
    expect(prompt).toContain("Staged files:");
    expect(prompt).toContain(context.stagedPatch);
    expect(prompt).toContain("Use a direct tone.");
  });

  it("extracts normalized assistant text", () => {
    expect(extractModelText({ content: [{ type: "output_text", text: '{"subject":"Add Git view","body":""}' }] })).toContain("Add Git view");
  });

  it("parses and formats schema-shaped output", () => {
    expect(parseGeneratedCommitMessage('{"subject":"Add Git view.","body":""}', false)).toEqual({
      subject: "Add Git view",
      body: "",
      message: "Add Git view",
    });
  });

  it("rejects vague subjects", () => {
    expect(() => parseGeneratedCommitMessage('{"subject":"Refine workspace UI","body":""}', false)).toThrow("vague verb");
  });

  it("requires a concrete bullet body for large changes", () => {
    expect(() => parseGeneratedCommitMessage('{"subject":"Add Git workspace","body":""}', true)).toThrow("2-5 body bullet points");
    const result = parseGeneratedCommitMessage(
      '{"subject":"Add Git workspace","body":"- Add a resizable diff view for working-tree changes\\n- Move permission controls into persistent settings"}',
      true
    );
    expect(result.body).toContain("resizable diff view");
  });
});
