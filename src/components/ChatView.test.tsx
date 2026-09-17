// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ChatView from "./ChatView";
import type { ChatItem } from "../store";

// jsdom has no ResizeObserver; ChatView's follow-scroll effect needs one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!globalThis.ResizeObserver) {
  (globalThis as any).ResizeObserver = ResizeObserverStub;
}

afterEach(() => cleanup());

/** One turn: user prompt, a running tool, and the final assistant reply. */
function turn(assistantStreaming: boolean): ChatItem[] {
  return [
    { kind: "user", key: "u1", text: "deploy it", entryId: "e1" },
    { kind: "tool", key: "t1", toolCallId: "tc1", name: "bash", args: { command: "npm run build" }, status: "running" },
    { kind: "assistant", key: "a1", blocks: [{ type: "text", text: "Deployed." }], streaming: assistantStreaming },
  ];
}

// The fold toggle's aria-label encodes the state: collapsed turns read
// "Expand N hidden steps: …", live-expanded ones read "Collapse turn: …".
const COLLAPSED = /Expand \d+ hidden steps/;
const EXPANDED = /Collapse turn/;

describe("ChatView turn folding with stream responses", () => {
  it("streaming on: the live turn stays expanded while the agent runs", () => {
    render(<ChatView items={turn(true)} streaming streamResponses />);
    const toggle = screen.getByRole("button", { name: EXPANDED });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // The final message is the anchor in every state.
    expect(screen.getByText("Deployed.")).toBeTruthy();
  });

  it("streaming on: folds everything but the final message when the run settles", () => {
    render(<ChatView items={turn(false)} streaming={false} streamResponses />);
    const toggle = screen.getByRole("button", { name: COLLAPSED });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Deployed.")).toBeTruthy();
  });

  it("streaming off: turns stay folded while running, unchanged", () => {
    render(<ChatView items={turn(true)} streaming streamResponses={false} />);
    const toggle = screen.getByRole("button", { name: COLLAPSED });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Deployed.")).toBeTruthy();
  });
});