// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Composer from "./Composer";
import type { Bot } from "../bots";
import type { CommandInfo } from "../bridge";

afterEach(() => cleanup());

const COMMANDS: CommandInfo[] = [
  { name: "deploy", description: "Deploy the project", source: "prompt" },
  { name: "review", description: "Review changes", source: "prompt" },
  { name: "skill:commit", description: "Commit skill", source: "skill" },
];

const BOTS: Bot[] = [
  { id: "b1", name: "brain" } as Bot,
];

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    streaming: false,
    steering: [],
    followUp: [],
    commands: COMMANDS,
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
    mentionBots: BOTS,
    ...overrides,
  };
}

describe("composer autocomplete", () => {
  it("accepts a slash command with Enter", async () => {
    render(<Composer {...baseProps({})} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    await userEvent.type(box, "/dep");
    expect(await screen.findByRole("listbox", { name: "Slash commands" })).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    expect(box.value).toBe("/deploy");
  });

  it("dismisses the command menu with Escape and submits on Enter", async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer {...baseProps({ onSend })} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    await userEvent.type(box, "/dep");
    await screen.findByRole("listbox", { name: "Slash commands" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalled();
  });

  it("accepts an @-mention with Tab", async () => {
    render(<Composer {...baseProps({})} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    await userEvent.type(box, "@br");
    await screen.findByText("brain");
    await userEvent.keyboard("{Tab}");
    expect(box.value).toBe("@brain ");
  });

  it("accepts a $-skill with Enter", async () => {
    render(<Composer {...baseProps({})} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    await userEvent.type(box, "$com");
    await screen.findByRole("listbox", { name: "Skills" });
    await userEvent.keyboard("{Enter}");
    expect(box.value).toBe("$commit ");
  });
});
