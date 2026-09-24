// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import DesignReviewCard, { isDesignReviewDetails } from "./DesignReviewCard";
import { bridge } from "../bridge";
import type { ChatItem } from "../store";
import { ToolCard } from "./items";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Substring assertions on the rendered text: a text matcher that walks
 *  ancestors matches every wrapper, which is noise here. */
const shown = (text: string): boolean => (document.body.textContent ?? "").includes(text);

const failRound = {
  round: 2,
  verdict: "fail" as const,
  punchlist: ["Header spacing is too tight", "CTA wraps below 390px"],
  note: "Hierarchy now matches the direction.",
  escalated: false,
  shots: [
    { viewport: "iPhone 15 Pro", path: ".babylon/design/x/reviews/round-2/iphone.png", width: 390, height: 844 },
    { viewport: "Chrome", path: ".babylon/design/x/reviews/round-2/chrome.png", width: 1280, height: 800 },
  ],
  at: "2026-09-24T00:00:00.000Z",
};

describe("isDesignReviewDetails", () => {
  it("accepts a real record and rejects anything else", () => {
    expect(isDesignReviewDetails(failRound)).toBe(true);
    expect(isDesignReviewDetails({ round: 1, verdict: "pass", punchlist: [], shots: [] })).toBe(true);
    expect(isDesignReviewDetails({ patch: "diff" })).toBe(false);
    expect(isDesignReviewDetails(null)).toBe(false);
    // A verdict without shots is still a record (native rounds have none).
    expect(isDesignReviewDetails({ round: 1, verdict: "fail", punchlist: ["x"] })).toBe(false);
  });
});

describe("DesignReviewCard", () => {
  it("shows the screenshots, the punchlist and the note together", async () => {
    vi.spyOn(bridge, "designReviewShot").mockImplementation(async ({ path }) => ({
      dataUrl: `data:image/png;base64,${path.length}`,
    }));
    render(<DesignReviewCard details={failRound} cwd="/repo" />);

    expect(shown("Design review 2")).toBe(true);
    expect(shown("Needs work")).toBe(true);
    // The punchlist is the review itself, not a summary of one.
    expect(shown("Header spacing is too tight")).toBe(true);
    expect(shown("CTA wraps below 390px")).toBe(true);
    expect(shown("Hierarchy now matches the direction.")).toBe(true);
    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(2));
    expect(bridge.designReviewShot).toHaveBeenCalledWith({
      cwd: "/repo",
      path: ".babylon/design/x/reviews/round-2/iphone.png",
    });
  });

  it("passes a round without screenshots or notes", () => {
    render(<DesignReviewCard details={{ round: 1, verdict: "pass", punchlist: [], shots: [] }} cwd="/repo" />);
    expect(shown("Passes")).toBe(true);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  it("surfaces escalation when the round budget is spent", () => {
    render(<DesignReviewCard details={{ ...failRound, round: 3, escalated: true }} cwd="/repo" />);
    expect(shown("round budget reached")).toBe(true);
  });

  it("still renders the verdict when a screenshot cannot be read", async () => {
    vi.spyOn(bridge, "designReviewShot").mockRejectedValue(new Error("missing"));
    render(<DesignReviewCard details={failRound} cwd="/repo" />);
    // The label stands in for the image, and nothing throws.
    await waitFor(() => expect(shown("iPhone 15 Pro")).toBeTruthy());
    expect(shown("Needs work")).toBe(true);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("transcript integration", () => {
  it("renders a design_review tool call as the review block, not a tool row", () => {
    const item: Extract<ChatItem, { kind: "tool" }> = {
      kind: "tool",
      key: "t1",
      toolCallId: "c1",
      name: "design_review",
      status: "done",
      output: "Design review round 2/3: FAIL",
      details: failRound,
    };
    render(<ToolCard item={item} cwd="/repo" />);
    expect(shown("Design review 2")).toBe(true);
    expect(document.querySelector(".tool-row")).toBeNull();
  });

  it("leaves an in-flight review as a normal tool row", () => {
    const item: Extract<ChatItem, { kind: "tool" }> = {
      kind: "tool",
      key: "t2",
      toolCallId: "c2",
      name: "design_review",
      status: "running",
    };
    render(<ToolCard item={item} cwd="/repo" />);
    expect(document.querySelector(".tool-row")).toBeTruthy();
  });

  it("does not hijack other tools that carry a details payload", () => {
    const item: Extract<ChatItem, { kind: "tool" }> = {
      kind: "tool",
      key: "t3",
      toolCallId: "c3",
      name: "browser_capture_review",
      status: "done",
      details: { patch: "diff --git a b" },
    };
    render(<ToolCard item={item} cwd="/repo" />);
    expect(document.querySelector(".tool-row")).toBeTruthy();
  });
});
