// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantMessage, ToolCard } from "./items";
import { bridge } from "../bridge";

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

describe("ToolCard full output", () => {
  function toolItem() {
    return {
      kind: "tool",
      key: "t1",
      toolCallId: "tc1",
      name: "test-tool",
      args: {},
      status: "done",
      output: "partial…",
      truncated: true,
    } as never;
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
