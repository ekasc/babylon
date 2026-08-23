import { describe, expect, it } from "vitest";
import { buildCommitPushTask } from "./git-commit-subagent";

describe("commit and push subagent task", () => {
  it("hardcodes Git safety and Unslop instructions", () => {
    const task = buildCommitPushTask("Use Conventional Commits.");
    expect(task).toContain("Inspect git status");
    expect(task).toContain("Respect .gitignore");
    expect(task).toContain("git add -A");
    expect(task).toContain("push the current branch");
    expect(task).toContain("Commit-writing rules from the Unslop skill");
    expect(task).toContain("Do not edit source files");
    expect(task).toContain("Do not bypass hooks");
    expect(task).toContain("Use Conventional Commits.");
  });

  it("bounds user instructions", () => {
    const task = buildCommitPushTask("x".repeat(5_000));
    expect(task.length).toBeLessThan(6_000);
  });
});
