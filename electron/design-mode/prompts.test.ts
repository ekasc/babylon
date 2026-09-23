import { describe, expect, it } from "vitest";
import {
  BRIEF_TEMPLATE,
  BRAND_TEMPLATE,
  DESIGN_UNTITLED_SUBJECT,
  renderDesignStatus,
  renderDesignSystemPrompt,
  renderStageFollowUp,
} from "./prompts";
import { createDesignState } from "./store";

describe("design prompts", () => {
  const state = createDesignState("Us screen", "us-screen");
  it("brief and brand templates carry the required sections", () => {
    for (const section of ["Target", "Scope", "Goals", "Audience", "Required content", "Constraints", "Viewports"]) {
      expect(BRIEF_TEMPLATE).toContain(section);
    }
    for (const section of ["Tokens", "Type", "Rhythm", "References"]) {
      expect(BRAND_TEMPLATE).toContain(section);
    }
  });
  it("elicitation happens in plain chat, never via dialogs or commands", () => {
    expect(renderStageFollowUp(state, "elicit")).not.toContain("Use ask_question");
    expect(renderStageFollowUp(state, "elicit")).not.toContain("/design approve-brief");
    expect(renderDesignSystemPrompt(state, "elicit")).not.toContain("Use ask_question");
    expect(renderDesignSystemPrompt(state, "elicit")).toContain("plain chat");
    expect(renderDesignSystemPrompt(state, "elicit")).toContain("Do not build anything yet");
  });
  it("brand stage gates build on GUI approval", () => {
    const followUp = renderStageFollowUp(state, "brand");
    expect(followUp).not.toContain("via ask_question");
    expect(followUp).not.toContain("/design approve-brand");
    expect(followUp).toContain("composer Approve brand");
    expect(followUp).toContain("Do not implement anything");
    expect(renderDesignSystemPrompt(state, "brand")).not.toContain("via ask_question");
  });
  it("build stage bounds the judge loop and names escalation", () => {
    const followUp = renderStageFollowUp(state, "build");
    expect(followUp).toContain("browser_capture_review");
    expect(followUp).toContain("3 rounds");
    expect(followUp).toContain("Escalation is a designed outcome");
  });
  it("native build judges attached screenshots, never a URL capture", () => {
    const native = { ...state, target: "native" as const };
    const followUp = renderStageFollowUp(native, "build");
    expect(followUp).not.toContain("browser_capture_review");
    expect(followUp).toContain("simulator screenshots");
    expect(followUp).toContain("never fake a verdict");
    expect(followUp).toContain("3 rounds");
    expect(renderDesignSystemPrompt(native, "build")).toContain("attached simulator screenshots");
  });
  it("system prompt stays compact and silent per stage", () => {
    expect(renderDesignSystemPrompt(state, "elicit")).toContain("Do not build anything yet");
    expect(renderDesignSystemPrompt(state, "elicit")).not.toContain("Use ask_question");
    expect(renderDesignSystemPrompt(state, "build")).toContain("Brief + brand are approved");
    expect(renderDesignSystemPrompt(state, "build")).not.toContain("via ask_question");
    expect(renderDesignStatus(null)).toContain("/design start");
    expect(renderDesignStatus(state)).toContain("pending");
  });
  it("untitled fallback never leaks into the system prompt", () => {
    const untitled = createDesignState(DESIGN_UNTITLED_SUBJECT, "untitled-design");
    const prompt = renderDesignSystemPrompt(untitled, "elicit");
    expect(prompt).not.toContain(DESIGN_UNTITLED_SUBJECT);
    expect(prompt).toContain("first message defines it");
  });
});
