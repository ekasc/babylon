import { describe, expect, it } from "vitest";
import {
  BRIEF_TEMPLATE,
  DIRECTION_TEMPLATE,
  DESIGN_UNTITLED_SUBJECT,
  renderDesignStatus,
  renderDesignSystemPrompt,
  renderStageFollowUp,
} from "./prompts";
import { createDesignState } from "./store";

describe("design prompts", () => {
  const state = createDesignState("Us screen", "us-screen");
  it("brief and direction templates carry the required sections", () => {
    for (const section of ["Target", "Scope", "Goals", "Audience", "Required content", "Constraints", "Viewports"]) {
      expect(BRIEF_TEMPLATE).toContain(section);
    }
    // The direction must cover product UI work, not just a palette: intent,
    // layout, components and interaction are first-class, not an afterthought.
    for (const section of [
      "Intent",
      "Visual language",
      "Typography",
      "Spacing & density",
      "Layout hierarchy",
      "Component conventions",
      "Interaction & motion",
      "Responsive behavior",
      "Existing system to preserve",
      "References",
    ]) {
      expect(DIRECTION_TEMPLATE).toContain(section);
    }
    // The intent vocabulary is the three ways design work actually relates to
    // an existing system.
    expect(DIRECTION_TEMPLATE).toContain("extend");
    expect(DIRECTION_TEMPLATE).toContain("evolve");
    expect(DIRECTION_TEMPLATE).toContain("rethink");
  });
  it("reads before it asks, and caps the interview at two blockers", () => {
    const elicit = renderDesignSystemPrompt(state, "elicit");
    // The repo answers most of the brief: investigate first.
    expect(elicit).toContain("reading the repository first");
    expect(elicit).toContain("Infer from the repository");
    expect(elicit).toContain("Never ask what you just read");
    expect(elicit).toContain("at most TWO blocking questions");
    // The intent decides how much freedom the work has.
    expect(elicit).toContain("EXTEND");
    expect(elicit).toContain("EVOLVE");
    expect(elicit).toContain("RETHINK");
    // The checklist is gone: the follow-up asks for decisions, not categories.
    const followUp = renderStageFollowUp(state, "elicit");
    expect(followUp).toContain("at most TWO blocking questions");
    expect(followUp).toContain("EXTEND");
    expect(followUp).not.toContain("5. required content");
    // The brief records the intent and the system to preserve.
    expect(BRIEF_TEMPLATE).toContain("## Intent");
    expect(BRIEF_TEMPLATE).toContain("## Existing system to preserve");
  });

  it("asks the model to report its build phase", () => {
    expect(renderDesignSystemPrompt(state, "build")).toContain("design_set_phase");
  });

  it("elicitation happens in plain chat, never via dialogs or commands", () => {
    expect(renderStageFollowUp(state, "elicit")).not.toContain("Use ask_question");
    expect(renderStageFollowUp(state, "elicit")).not.toContain("/design approve-brief");
    expect(renderDesignSystemPrompt(state, "elicit")).not.toContain("Use ask_question");
    expect(renderDesignSystemPrompt(state, "elicit")).toContain("plain chat");
    expect(renderDesignSystemPrompt(state, "elicit")).toContain("Do not build anything yet");
  });
  it("direction stage gates build on GUI approval", () => {
    const followUp = renderStageFollowUp(state, "brand");
    expect(followUp).not.toContain("via ask_question");
    expect(followUp).not.toContain("/design approve-brand");
    expect(followUp).toContain("composer Approve direction");
    // Direction is derived from the repo when the repo already answers.
    expect(followUp).toContain("Derive what the repository already answers");
    expect(followUp).toContain("Do not implement anything");
    expect(renderDesignSystemPrompt(state, "brand")).not.toContain("via ask_question");
    expect(renderDesignSystemPrompt(state, "brand")).toContain("Read the repository first");
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
    expect(renderDesignSystemPrompt(state, "build")).toContain("Brief + direction are approved");
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
