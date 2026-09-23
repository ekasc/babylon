// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import ChatView from "./ChatView";
import type { ChatItem } from "../store";

// jsdom has no ResizeObserver; both the follow-scroll effect and the turn
// measurement observer need one.
class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Fifty settled turns, no folds (user+assistant pairs): every row renders
// when mounted, so mounted DOM counts the window exactly. jsdom has no
// layout (no ResizeObserver, clientHeight 0), so all heights are the
// fallback estimate and the initial window is the bottom band.
function fiftyTurns(): ChatItem[] {
  const items: ChatItem[] = [];
  for (let i = 0; i < 50; i++) {
    items.push({ kind: "user", key: `u${i}`, text: `q${i}`, entryId: `e${i}` });
    items.push({ kind: "assistant", key: `a${i}`, blocks: [{ type: "text", text: `r${i}` }] });
  }
  return items;
}

function mountedTurnIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-turn-id]")].map((el) => (el as HTMLElement).dataset.turnId!);
}

describe("ChatView turn windowing", () => {
  it("mounts only the bottom band on open, with a top spacer", () => {
    const { container } = render(<ChatView items={fiftyTurns()} streaming={false} sessionKey="s1" />);
    const ids = mountedTurnIds(container);
    // Bottom band: last 2*OVERSCAN+1 = 9 turns, stable turn-id keys.
    expect(ids).toHaveLength(9);
    expect(ids[0]).toBe("e41");
    expect(ids[ids.length - 1]).toBe("e49");
    // 41 turns above at the 320px fallback estimate.
    const spacer = container.querySelector('[aria-hidden="true"]') as HTMLElement | null;
    expect(spacer).not.toBeNull();
    expect(spacer!.style.height).toBe(`${41 * 320}px`);
    // Mounted rows, not the full transcript.
    expect(container.querySelectorAll(".chat-item").length).toBeLessThan(100);
  });

  it("resets to the new session's bottom band on switch, never reusing layout", () => {
    const first = fiftyTurns();
    const { container, rerender } = render(<ChatView items={first} streaming={false} sessionKey="s1" />);
    expect(mountedTurnIds(container)[0]).toBe("e41");
    const second = fiftyTurns().map((item) => ({ ...item, key: `n-${item.key}`, entryId: item.kind === "user" ? `n-${item.entryId}` : undefined }));
    rerender(<ChatView items={second} streaming={false} sessionKey="s2" />);
    const ids = mountedTurnIds(container);
    expect(ids).toHaveLength(9);
    expect(ids[0]).toBe("n-e41");
    expect(ids[ids.length - 1]).toBe("n-e49");
  });

  it("keeps rendering every row when the transcript fits the window", () => {
    const items = fiftyTurns().slice(0, 6);
    const { container } = render(<ChatView items={items} streaming={false} sessionKey="s1" />);
    expect(mountedTurnIds(container)).toEqual(["e0", "e1", "e2"]);
    expect(container.querySelectorAll(".chat-item").length).toBe(6);
  });
});
