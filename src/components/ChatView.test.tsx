// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatView, { findTranscriptMatches, formatBlockquote } from "./ChatView";
import type { ChatItem } from "../store";

// jsdom has no ResizeObserver; ChatView's follow-scroll effect needs one.
class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = ResizeObserverStub;
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
describe("fold-row rollback", () => {
  const historyTurn = {
    entryId: "e1",
    parentUserEntryId: null,
    index: 1,
    depth: 0,
    text: "deploy it",
    response: "Deployed.",
    onActivePath: true,
    current: true,
    branchCount: 0,
    changedCount: 0,
    checkpointAvailable: true,
    rollbackAvailable: true,
  };

  it("owns Rollback in the fold row and hides the floating chip on folded turns", async () => {
    const onRollback = vi.fn();
    render(<ChatView items={turn(false)} streaming={false} historyTurns={[historyTurn]} onRollback={onRollback} />);
    const buttons = screen.getAllByRole("button", { name: "Rollback" });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]!);
    expect(onRollback).toHaveBeenCalledWith("e1");
  });

  it("keeps the floating chip on turns without a fold", () => {
    const onRollback = vi.fn();
    render(
      <ChatView
        items={[
          { kind: "user", key: "u1", text: "hi", entryId: "e9" },
          { kind: "assistant", key: "a1", blocks: [{ type: "text", text: "hello" }], streaming: false },
        ]}
        streaming={false}
        historyTurns={[{ ...historyTurn, entryId: "e9", text: "hi", response: "hello" }]}
        onRollback={onRollback}
      />
    );
    // No fold row: no expand/collapse toggle, floating Rollback only.
    expect(screen.queryByRole("button", { name: /Expand|Collapse turn/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Rollback" })).toHaveLength(1);
  });
});

describe("scroll follow ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function scroller() {
    const log = screen.getByRole("log");
    Object.defineProperty(log, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(log, "clientHeight", { value: 500, configurable: true });
    return log as HTMLElement;
  }

  function pinAtBottom() {
    const log = scroller();
    log.scrollTop = 1500;
    fireEvent.scroll(log);
    return log;
  }

  it("ignores anchoring jumps with no gesture (stays pinned, no jump button)", () => {
    render(<ChatView items={turn(false)} streaming={false} />);
    const log = pinAtBottom();
    // Layout shift / scroll anchoring moves the viewport isolated after
    // quiet: no gesture, no continuity with the earlier scroll.
    vi.setSystemTime(Date.now() + 1000);
    log.scrollTop = 1300;
    fireEvent.scroll(log);
    expect(screen.queryByRole("button", { name: "Jump to bottom" })).toBeNull();
  });

  it("unsticks on genuine wheel movement (jump button appears)", () => {
    render(<ChatView items={turn(false)} streaming={false} />);
    const log = pinAtBottom();
    fireEvent.wheel(log);
    log.scrollTop = 1300;
    fireEvent.scroll(log);
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toBeTruthy();
  });

  it("pins to the new message when pinNonce bumps (send)", () => {
    const settled = turn(false);
    const { rerender } = render(<ChatView items={settled} streaming={false} pinNonce={0} />);
    const log = scroller();
    log.scrollTop = 200;
    fireEvent.scroll(log);
    rerender(
      <ChatView
        items={[...settled, { kind: "assistant", key: "a2", blocks: [{ type: "text", text: "More." }], streaming: false }]}
        streaming={false}
        pinNonce={1}
      />
    );
    expect(log.scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: "Jump to bottom" })).toBeNull();
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

describe("virtualization latch", () => {
  const many = (n: number): ChatItem[] =>
    Array.from({ length: n }, (_, i) => ({ kind: "user", key: `u${i}`, text: `msg ${i}`, entryId: `e${i}` }));
  const longOn = () => document.querySelector(".chat-item-long") != null;

  it("latches on past 60 items, stays on while shrinking, resets on session switch", async () => {
    const { rerender } = render(<ChatView items={many(61)} streaming={false} sessionKey="s1" />);
    await waitFor(() => expect(longOn()).toBe(true));
    // Shrinking below the threshold does not unlatch mid-session.
    rerender(<ChatView items={many(5)} streaming={false} sessionKey="s1" />);
    expect(longOn()).toBe(true);
    // Emptying (new chat) unlatches.
    rerender(<ChatView items={[]} streaming={false} sessionKey="s1" />);
    expect(longOn()).toBe(false);
  });

  it("session switch re-evaluates from the new transcript, never the old latch", async () => {
    // Long -> long stays on (the new session is itself long).
    const { rerender } = render(<ChatView items={many(61)} streaming={false} sessionKey="s1" />);
    await waitFor(() => expect(longOn()).toBe(true));
    rerender(<ChatView items={many(61)} streaming={false} sessionKey="s2" />);
    await waitFor(() => expect(longOn()).toBe(true));
    // Long -> short turns off (the new session is short).
    rerender(<ChatView items={many(5)} streaming={false} sessionKey="s3" />);
    await waitFor(() => expect(longOn()).toBe(false));
    // Short -> long turns on.
    rerender(<ChatView items={many(61)} streaming={false} sessionKey="s4" />);
    await waitFor(() => expect(longOn()).toBe(true));
  });
});
