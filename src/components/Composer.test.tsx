// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Composer from "./Composer";

// Keep the real bridge exports; only spy on uiRespond so we can assert what
// the select dialog actually delivers to the agent.
const { uiRespond } = vi.hoisted(() => ({ uiRespond: vi.fn(async () => undefined) }));
vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, uiRespond } };
});

afterEach(() => {
  cleanup();
  uiRespond.mockClear();
});

const DIALOG = {
  id: "d1",
  method: "select" as const,
  title: "Where should agent messages show?",
  options: ["Main chat", "Activity", "Something else — describe it"],
};

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    streaming: false,
    steering: [],
    followUp: [],
    commands: [],
    agentState: null,
    stats: {},
    models: [],
    thinkingLevels: [],
    toast: vi.fn(),
    onSend: vi.fn(async () => true),
    onAbort: vi.fn(),
    onSetModel: vi.fn(),
    onSetThinking: vi.fn(),
    onCompact: vi.fn(),
    onDialogDismiss: vi.fn(),
    ...overrides,
  };
}

describe("Composer select dialog (ask_question with options)", () => {
  it("delivers a typed custom answer via Enter", async () => {
    const onDismiss = vi.fn();
    render(<Composer {...baseProps({ dialogs: [DIALOG], onDialogDismiss: onDismiss })} />);
    const input = screen.getByLabelText("Custom answer");
    await userEvent.type(input, "the terminal block should match the composer");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(uiRespond).toHaveBeenCalledTimes(1));
    expect(uiRespond).toHaveBeenCalledWith({ id: "d1", value: "the terminal block should match the composer" });
    expect(onDismiss).toHaveBeenCalledWith("d1");
  });

  it("sends the typed description even when an option is clicked afterwards", async () => {
    render(<Composer {...baseProps({ dialogs: [DIALOG] })} />);
    const input = screen.getByLabelText("Custom answer");
    await userEvent.type(input, "my real description");
    await userEvent.click(screen.getByRole("button", { name: /Something else/ }));
    await waitFor(() => expect(uiRespond).toHaveBeenCalledTimes(1));
    expect(uiRespond).toHaveBeenCalledWith({ id: "d1", value: "my real description" });
  });

  it("sends the option label when no custom text was typed", async () => {
    render(<Composer {...baseProps({ dialogs: [DIALOG] })} />);
    await userEvent.click(screen.getByRole("button", { name: /Main chat/ }));
    await waitFor(() => expect(uiRespond).toHaveBeenCalledTimes(1));
    expect(uiRespond).toHaveBeenCalledWith({ id: "d1", value: "Main chat" });
  });
});