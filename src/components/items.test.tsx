// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantMessage, ToolCard, UserMessage } from "./items";
import { bridge } from "../bridge";
import type { ChatItem } from "../store";

afterEach(() => cleanup());

describe("AssistantMessage working header", () => {
  it("shows an elapsed working status while streaming with content", () => {
    render(
      <AssistantMessage
        item={{ kind: "assistant", key: "a1", blocks: [{ type: "text", text: "Deployed." }], streaming: true }}
      />
    );
    expect(screen.getByRole("status").textContent).toMatch(/Working/);
    // Content still renders beneath the header.
    expect(screen.getByText("Deployed.")).toBeTruthy();
  });

  it("shows the working status for an empty in-flight message", () => {
    render(<AssistantMessage item={{ kind: "assistant", key: "a1", blocks: [], streaming: true }} />);
    expect(screen.getByRole("status").textContent).toMatch(/Working/);
  });

  it("shows no status once settled", () => {
    render(
      <AssistantMessage
        item={{ kind: "assistant", key: "a1", blocks: [{ type: "text", text: "Deployed." }], streaming: false }}
      />
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("assistant copy button", () => {
  const writeText = vi.fn(async (_text: string) => {});
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("copies the reply text without reasoning and confirms", async () => {
    render(
      <AssistantMessage
        item={{
          kind: "assistant",
          key: "a1",
          blocks: [
            { type: "text", text: "Hello" },
            { type: "thinking", text: "secret plan" },
            { type: "text", text: "World" },
          ],
          streaming: false,
        }}
      />
    );
    // fireEvent: the button is hover-revealed (opacity-0), which pointer-based
    // user-event refuses to click; dispatch directly instead.
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(writeText).toHaveBeenCalledWith("Hello\n\nWorld");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("stays hidden while streaming and without text", () => {
    render(
      <AssistantMessage
        item={{ kind: "assistant", key: "a1", blocks: [{ type: "text", text: "partial" }], streaming: true }}
      />
    );
    expect(screen.queryByRole("button", { name: /Copy message|Copied/ })).toBeNull();
    cleanup();
    render(
      <AssistantMessage
        item={{ kind: "assistant", key: "a1", blocks: [{ type: "thinking", text: "only thoughts" }], streaming: false }}
      />
    );
    expect(screen.queryByRole("button", { name: /Copy message|Copied/ })).toBeNull();
  });
});

describe("UserMessage skill blocks", () => {
  const BLOCK =
    '<skill name="review" location="/skills/review/SKILL.md">\nReferences are relative to /skills/review.\n\n# Review\nBe thorough.\n</skill>';

  function userItem(text: string): Extract<ChatItem, { kind: "user" }> {
    return { kind: "user", key: "u1", text };
  }

  it("collapses an engine-expanded skill block to a chip", () => {
    render(<UserMessage item={userItem(BLOCK)} />);
    expect(screen.getByText("/skill:review")).toBeTruthy();
    // The inlined document stays hidden until toggled.
    expect(screen.queryByText(/Be thorough/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /show SKILL.md/i }));
    expect(screen.getByText(/Be thorough/)).toBeTruthy();
    // The expanded view shows the document, not the wrapper tags.
    expect(screen.queryByText(/<skill name/)).toBeNull();
  });

  it("shows trailing args next to the chip", () => {
    render(<UserMessage item={userItem(`${BLOCK}\n\nauth.ts`)} />);
    expect(screen.getByText("/skill:review")).toBeTruthy();
    expect(screen.getByText("auth.ts")).toBeTruthy();
  });
});

describe("ToolCard full output", () => {
  function toolItem(): Extract<ChatItem, { kind: "tool" }> {
    return {
      kind: "tool",
      key: "t1",
      toolCallId: "tc1",
      name: "test-tool",
      args: {},
      status: "done",
      output: "partial…",
      truncated: true,
    };
  }

  it("loads and shows the full output", async () => {
    const spy = vi.spyOn(bridge, "getToolOutput").mockResolvedValue({ content: "FULL", truncated: false });
    try {
      render(<ToolCard item={toolItem()} />);
      fireEvent.click(screen.getByText("test-tool"));
      fireEvent.click(await screen.findByRole("button", { name: "Show full output" }));
      expect(await screen.findByText("FULL")).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it("reports load failures inline", async () => {
    const spy = vi.spyOn(bridge, "getToolOutput").mockRejectedValue(new Error("gone"));
    try {
      render(<ToolCard item={toolItem()} />);
      fireEvent.click(screen.getByText("test-tool"));
      fireEvent.click(await screen.findByRole("button", { name: "Show full output" }));
      expect(await screen.findByRole("alert")).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});
