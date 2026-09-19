// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatView, { findTranscriptMatches, formatBlockquote } from "./ChatView";
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
describe("quote in composer", () => {
  it("formats selections as a markdown blockquote", () => {
    expect(formatBlockquote("hello\n\nworld")).toBe("> hello\n>\n> world");
  });

  function selectText(text: string) {
    const el = screen.getByText(text);
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }

  it("offers Quote for assistant selections and sends the blockquote", async () => {
    const onQuote = vi.fn();
    render(<ChatView items={turn(false)} streaming={false} onQuote={onQuote} />);
    selectText("Deployed.");
    const quote = await screen.findByRole("button", { name: "Quote selection in composer" });
    await userEvent.click(quote);
    expect(onQuote).toHaveBeenCalledWith("> Deployed.");
  });

  it("ignores user-message selections", () => {
    const onQuote = vi.fn();
    render(<ChatView items={turn(false)} streaming={false} onQuote={onQuote} />);
    selectText("deploy it");
    expect(screen.queryByRole("button", { name: "Quote selection in composer" })).toBeNull();
  });
});

describe("findTranscriptMatches", () => {
  const items = [
    { kind: "user", key: "u1", text: "deploy the API" },
    { kind: "assistant", key: "a1", blocks: [{ type: "text", text: "API deployed." }] },
    { kind: "tool", key: "t1", toolCallId: "tc1", name: "bash", args: { command: "deploy API" }, status: "done" },
    { kind: "system", key: "s1", text: "nothing relevant" },
  ] as never[];
  const match = findTranscriptMatches;

  it("matches message text case-insensitively and skips tools", () => {
    expect(match(items, "api").map((m) => m.key)).toEqual(["u1", "a1"]);
  });

  it("returns empty for blank queries", () => {
    expect(match(items, "   ")).toEqual([]);
  });
});

describe("in-transcript find bar", () => {
  it("opens on Cmd+F, counts matches, and flashes the jumped row", async () => {
    render(<ChatView items={turn(false)} streaming={false} />);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in transcript" });
    await userEvent.type(input, "deploy");
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy());
    await waitFor(() => expect(document.querySelector(".find-target-flash")).toBeTruthy());
  });

  it("closes on Escape", async () => {
    render(<ChatView items={turn(false)} streaming={false} />);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in transcript" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Find in transcript" })).toBeNull();
    expect(input.isConnected).toBe(false);
  });
});
