import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeSkillEntries, parseSkillFrontmatter, readUserSkillEntries } from "./user-skills";

function skillMd(name: string, description = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;
}

describe("parseSkillFrontmatter", () => {
  it("reads name and description", () => {
    expect(parseSkillFrontmatter(skillMd("review", "Reviews code"), "whatever")).toEqual({
      name: "skill:review",
      description: "Reviews code",
    });
  });

  it("falls back to the directory name", () => {
    expect(parseSkillFrontmatter("no frontmatter\n", "my-skill")).toEqual({ name: "skill:my-skill", description: "" });
  });

  it("skips unusable entries", () => {
    expect(parseSkillFrontmatter("no frontmatter\n", "Not A Skill")).toBeNull();
    expect(parseSkillFrontmatter("---\nname: BAD NAME\n---\n", "also-bad!")).toBeNull();
  });
});

describe("readUserSkillEntries", () => {
  it("reads valid skills and skips the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "babylon-user-skills-"));
    mkdirSync(join(dir, "review"));
    writeFileSync(join(dir, "review", "SKILL.md"), skillMd("review", "Reviews code"));
    mkdirSync(join(dir, "empty"));
    mkdirSync(join(dir, "second"));
    writeFileSync(join(dir, "second", "SKILL.md"), skillMd("review", "Duplicate name"));
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "SKILL.md"), "just notes, falls back to dirname");
    mkdirSync(join(dir, "junk drawer"));
    writeFileSync(join(dir, "junk drawer", "SKILL.md"), "no name anywhere");
    expect(readUserSkillEntries(dir)).toEqual([
      { name: "skill:notes", description: "" },
      { name: "skill:review", description: "Reviews code" },
    ]);
    expect(readUserSkillEntries(join(dir, "missing"))).toEqual([]);
  });
});

describe("mergeSkillEntries", () => {
  it("unions both sources with pi winning ties", () => {
    const existing = [{ name: "skill:review", description: "pi copy", source: "skill" as const }];
    expect(
      mergeSkillEntries(existing, [
        { name: "skill:review", description: "user copy", source: "skill" as const },
        { name: "skill:plan", description: "user only", source: "skill" as const },
      ])
    ).toEqual([
      { name: "skill:review", description: "pi copy", source: "skill" },
      { name: "skill:plan", description: "user only", source: "skill" },
    ]);
  });
});
