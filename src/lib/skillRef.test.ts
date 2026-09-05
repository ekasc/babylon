import { describe, expect, it } from "vitest";
import { expandSkillMentions, parseSkillRef, stripSkillPrefix } from "./skillRef";

describe("parseSkillRef", () => {
  it("detects a bare skill invocation as a non-full chip", () => {
    expect(parseSkillRef("/skill:review")).toEqual({ name: "review", full: false });
  });

  it("keeps a one-line argument visible (not full)", () => {
    const ref = parseSkillRef("/skill:review auth.ts");
    expect(ref).toEqual({ name: "review", full: false });
  });

  it("treats text pasted after the chip as a full document", () => {
    const ref = parseSkillRef("/skill:review\n# Review\nSome long body…");
    expect(ref?.name).toBe("review");
    expect(ref?.full).toBe(true);
  });

  it("collapses a frontmatter SKILL.md to a chip", () => {
    const md =
      "---\nname: demo-skill\ndescription: Demo skill for command discovery.\n---\n\n# Demo\n\nSome body text.";
    expect(parseSkillRef(md)).toEqual({ name: "demo-skill", full: true });
  });

  it("returns null for ordinary messages", () => {
    expect(parseSkillRef("Please review the auth module")).toBeNull();
    expect(parseSkillRef("Here is a description: of a bug and name: bob")).toBeNull();
  });

  it("does not collapse short messages mentioning description/name", () => {
    expect(parseSkillRef("description: foo\nname: bar")).toBeNull();
  });
});

describe("stripSkillPrefix", () => {
  it("strips the skill: prefix for display", () => {
    expect(stripSkillPrefix("skill:review")).toBe("review");
    expect(stripSkillPrefix("review")).toBe("review");
  });
});

describe("expandSkillMentions", () => {
  const names = ["review", "plan"];
  it("expands $mentions to canonical invocations", () => {
    expect(expandSkillMentions("please $review auth.ts", names)).toBe("please /skill:review auth.ts");
    expect(expandSkillMentions("$plan then $review", names)).toBe("/skill:plan then /skill:review");
  });
  it("leaves unknown names and shell-like tokens alone", () => {
    expect(expandSkillMentions("costs $5 and $HOME", names)).toBe("costs $5 and $HOME");
    expect(expandSkillMentions("run $reviewer now", names)).toBe("run $reviewer now");
    expect(expandSkillMentions("costs $5", [])).toBe("costs $5");
  });
  it("does not match prefixes of longer names", () => {
    expect(expandSkillMentions("$planed", ["plan", "planed"])).toBe("/skill:planed");
  });
});
