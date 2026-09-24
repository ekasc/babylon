// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent} from "@testing-library/react";
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
describe("Composer prompt stash", () => {
  it("stashes the draft on Cmd+S and shows the count badge", async () => {
    const toast = vi.fn();
    render(<Composer {...baseProps({ toast })} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    await userEvent.type(box, "park this thought");
    await userEvent.keyboard("{Meta>}s{/Meta}");
    expect(box.value).toBe("");
    expect(screen.getByRole("button", { name: "Stashed drafts (1)" })).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("info", "Draft stashed");
  });

  it("restores a stash by appending and removes the entry", async () => {
    render(<Composer {...baseProps({})} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    await userEvent.type(box, "parked idea");
    await userEvent.keyboard("{Control>}s{/Control}");
    await userEvent.click(screen.getByRole("button", { name: "Stashed drafts (1)" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /parked idea/ }));
    expect(box.value).toBe("parked idea");
    expect(screen.queryByRole("button", { name: /Stashed drafts \(\d+\)/ })).toBeNull();
  });

  it("appends a restored stash below existing text", async () => {
    render(<Composer {...baseProps({})} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    await userEvent.type(box, "first");
    await userEvent.keyboard("{Meta>}s{/Meta}");
    await userEvent.type(box, "second");
    await userEvent.click(screen.getByRole("button", { name: "Stashed drafts (1)" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /first/ }));
    expect(box.value).toBe("second\n\nfirst");
  });

  it("deletes a stash without restoring", async () => {
    render(<Composer {...baseProps({})} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    await userEvent.type(box, "drop me");
    await userEvent.keyboard("{Meta>}s{/Meta}");
    await userEvent.click(screen.getByRole("button", { name: "Stashed drafts (1)" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete stashed draft" }));
    expect(screen.queryByRole("button", { name: /Stashed drafts \(\d+\)/ })).toBeNull();
    expect(box.value).toBe("");
  });

  it("ignores stash on an empty draft", async () => {
    render(<Composer {...baseProps({})} />);
    await userEvent.click(screen.getByRole("textbox", { name: "Message Pi" }));
    await userEvent.keyboard("{Meta>}s{/Meta}");
    expect(screen.queryByRole("button", { name: /Stashed drafts \(\d+\)/ })).toBeNull();
  });
});

describe("Composer quote draftRequests", () => {
  it("appends quote text below the existing draft", async () => {
    const { rerender } = render(<Composer {...baseProps({})} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    await userEvent.type(box, "my words");
    rerender(<Composer {...baseProps({ draftRequest: { id: 1, text: "> quoted", append: true } })} />);
    expect(box.value).toBe("my words\n\n> quoted");
  });

  it("replaces the draft without append", async () => {
    const { rerender } = render(<Composer {...baseProps({})} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    await userEvent.type(box, "my words");
    rerender(<Composer {...baseProps({ draftRequest: { id: 2, text: "rollback text" } })} />);
    expect(box.value).toBe("rollback text");
  });
});

describe("composer draft persistence", () => {
  const KEY_A = "test-draft-a";
  const KEY_B = "test-draft-b";
  const stored = (k: string) => localStorage.getItem(`babylon:composer-draft:${k}`);

  it("restores the draft after remount", async () => {
    localStorage.removeItem(`babylon:composer-draft:${KEY_A}`);
    const { unmount } = render(<Composer {...baseProps({ sessionKey: KEY_A })} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Message Pi" }), "half thought");
    expect(stored(KEY_A)).toBe("half thought");
    unmount();
    render(<Composer {...baseProps({ sessionKey: KEY_A })} />);
    expect((screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement).value).toBe("half thought");
    localStorage.removeItem(`babylon:composer-draft:${KEY_A}`);
  });

  it("keeps drafts per session", async () => {
    localStorage.removeItem(`babylon:composer-draft:${KEY_A}`);
    localStorage.removeItem(`babylon:composer-draft:${KEY_B}`);
    const { rerender } = render(<Composer {...baseProps({ sessionKey: KEY_A })} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    await userEvent.type(box, "for A");
    rerender(<Composer {...baseProps({ sessionKey: KEY_B })} />);
    expect(box.value).toBe("");
    await userEvent.type(box, "for B");
    rerender(<Composer {...baseProps({ sessionKey: KEY_A })} />);
    expect(box.value).toBe("for A");
    localStorage.removeItem(`babylon:composer-draft:${KEY_A}`);
    localStorage.removeItem(`babylon:composer-draft:${KEY_B}`);
  });

  it("clears the saved draft on accepted send", async () => {
    localStorage.removeItem(`babylon:composer-draft:${KEY_A}`);
    render(<Composer {...baseProps({ sessionKey: KEY_A })} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    await userEvent.type(box, "send me");
    await userEvent.keyboard("{Enter}");
    await new Promise((r) => setTimeout(r, 0));
    expect(stored(KEY_A)).toBeNull();
  });
});

describe("composer design toggle", () => {
  it("arms without snapshotting the draft and marks the pressed mode", async () => {
    // Armed model: the subject comes from the next send, never the click.
    const onToggleDesign = vi.fn();
    render(<Composer {...baseProps({ onToggleDesign, designMode: "armed" })} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" });
    await userEvent.type(box, "Rehaul the US screen");
    await userEvent.click(screen.getByRole("button", { name: "Design" }));
    expect(onToggleDesign).toHaveBeenCalledWith();
    expect(screen.getByRole("button", { name: "Design" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the stage indicator while active", () => {
    render(<Composer {...baseProps({ onToggleDesign: vi.fn(), designMode: "active", designStage: "direction" })} />);
    expect(screen.getByRole("button", { name: /Design · Direction/ })).toBeTruthy();
    expect(document.querySelector(".composer-surface.is-design-mode")).toBeTruthy();
  });

  it("disables Design while a goal is armed or active", () => {
    render(<Composer {...baseProps({ onToggleDesign: vi.fn(), designMode: "off", goalMode: "armed" })} />);
    const button = screen.getByRole("button", { name: "Design" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/Goal/);
  });

  it("shows a pending approval as one row button, never a strip", async () => {
    const onApprove = vi.fn();
    const { container } = render(
      <Composer {...baseProps({ onToggleDesign: vi.fn(), designApproval: { label: "Approve brief", onApprove } })} />
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve brief" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".goal-strip")).toBeNull();
  });

  it("reports the build sub-phase instead of a bare Build", () => {
    const { unmount } = render(
      <Composer {...baseProps({ onToggleDesign: vi.fn(), designMode: "active", designStage: "build" })} />
    );
    expect(document.body.textContent).toContain("Design · Building");
    unmount();

    render(
      <Composer
        {...baseProps({
          onToggleDesign: vi.fn(),
          designMode: "active",
          designStage: "build",
          designSubphase: { kind: "reviewing", label: "Reviewing 2/3", round: 2, maxRounds: 3 },
        })}
      />
    );
    expect(document.body.textContent).toContain("Design · Reviewing 2/3");
  });

  it("opens the design menu from the stage indicator, not a toggle-off", async () => {
    const onEndDesign = vi.fn();
    const onRestartDesign = vi.fn();
    render(
      <Composer
        {...baseProps({
          onToggleDesign: vi.fn(),
          designMode: "active",
          designStage: "direction",
          onEndDesign,
          onRestartDesign,
        })}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /Design · Direction/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "End design" }));
    expect(onEndDesign).toHaveBeenCalledTimes(1);
    expect(onRestartDesign).not.toHaveBeenCalled();
  });

  it("disables Goal while design is armed or active", () => {
    render(<Composer {...baseProps({ onToggleGoal: vi.fn(), goalMode: "off", designMode: "active", designStage: "build" })} />);
    const button = screen.getByRole("button", { name: "Goal" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/Design/);
  });
});
describe("composer attachments policy", () => {
  beforeEach(() => {
    window.URL.createObjectURL = vi.fn(() => "blob:mock");
    window.URL.revokeObjectURL = vi.fn();
  });

  it("rejects HEIC with guidance", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(<Composer {...baseProps({})} />);
    const dock = document.querySelector(".composer-dock")!;
    fireEvent.drop(dock, { dataTransfer: { files: [new File(["x"], "photo.heic", { type: "" })] } });
    expect(await screen.findByText(/HEIC\/HEIF.*convert to JPEG or PNG/i)).toBeTruthy();
  });

  it("routes typeless image drags to the image path", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(<Composer {...baseProps({})} />);
    const dock = document.querySelector(".composer-dock")!;
    fireEvent.drop(dock, { dataTransfer: { files: [new File(["x"], "photo.jpg", { type: "" })] } });
    expect(await screen.findByAltText("photo.jpg")).toBeTruthy();
  });

  it("caps attachments per message", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(<Composer {...baseProps({})} />);
    const dock = document.querySelector(".composer-dock")!;
    const files = Array.from({ length: 10 }, (_, i) => new File(["x"], `f${i}.txt`, { type: "text/plain" }));
    fireEvent.drop(dock, { dataTransfer: { files } });
    expect(await screen.findByText(/not attached \(max 8 files/i)).toBeTruthy();
  });

  it("refuses oversized sends at submit", async () => {
    const onSend = vi.fn(async () => true);
    const { fireEvent } = await import("@testing-library/react");
    const toast = vi.fn();
    render(<Composer {...baseProps({ onSend, toast })} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" });
    fireEvent.change(box, { target: { value: "x".repeat(120_001) } });
    (box as HTMLTextAreaElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("error", expect.stringContaining("120,000"));
  });

  it("folds large pastes to stably-named files, bypassed by mod+Shift+V", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const toast = vi.fn();
    render(<Composer {...baseProps({ toast })} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" });
    const big = "x".repeat(33 * 1024);
    const paste = () =>
      fireEvent.paste(box, {
        clipboardData: { items: [], getData: () => big },
      } as unknown as ClipboardEvent);
    paste();
    expect(await screen.findByText("pasted-text.txt")).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("info", expect.stringContaining("pasted-text.txt"));
    toast.mockClear();
    await userEvent.click(box);
    await userEvent.keyboard("{Meta>}{Shift>}v{/Shift}{/Meta}");
    paste();
    await new Promise((r) => setTimeout(r, 50));
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("composer stash menu", () => {
  it("closes the open stash menu on Escape", async () => {
    render(<Composer {...baseProps({})} />);
    const box = screen.getByRole("textbox", { name: "Message Pi" });
    await userEvent.type(box, "park me");
    await userEvent.keyboard("{Meta>}s{/Meta}");
    await userEvent.click(screen.getByRole("button", { name: "Stashed drafts (1)" }));
    expect(screen.getByRole("menu", { name: "Stashed drafts" })).toBeTruthy();
    await userEvent.click(box);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Stashed drafts" })).toBeNull();
  });
});

describe("composer execution access gating", () => {
  const blockedAccess = {
    kind: "blocked" as const,
    ownerLabel: "Auth refactor",
    busyLabel: "is working",
    onReturnToLive: vi.fn(),
  };

  it("blocked: history-reading composer — disabled input, no runtime controls, Return to live", () => {
    render(<Composer {...baseProps({ executionAccess: blockedAccess })} />);
    const ta = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    expect(ta.disabled).toBe(true);
    expect(ta.placeholder).toBe("Viewing history");
    // Turn controls gone entirely.
    expect(screen.queryByLabelText("Send message")).toBeNull();
    expect(screen.queryByLabelText("Stop run")).toBeNull();
    expect(screen.queryByText("steer")).toBeNull();
    // Runtime-mutating controls gone: goal/design/model/thinking/permission.
    expect(screen.queryByText("Goal")).toBeNull();
    expect(screen.queryByText("Design")).toBeNull();
    expect(screen.queryByText("select model")).toBeNull();
    expect(screen.queryByTitle("Reasoning level")).toBeNull();
    expect(screen.queryByText("Auto")).toBeNull();
    // The one row that remains: owner identity + phrasing + explicit nav.
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Auth refactor");
    expect(status.textContent).toContain("is working");
    fireEvent.click(screen.getByRole("button", { name: "Return to live" }));
    expect(blockedAccess.onReturnToLive).toHaveBeenCalledTimes(1);
  });

  it("claimable: writable, but no controls that mutate the other runtime", async () => {
    render(<Composer {...baseProps({ executionAccess: { kind: "claimable" } })} />);
    const ta = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    expect(ta.disabled).toBe(false);
    await userEvent.type(ta, "fix the parser");
    const send = screen.getByLabelText("Send message") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    // No live/stream or foreign-runtime controls (no Stop; App feeds
    // streaming=false for non-owner views; model/thinking/goal/design hidden).
    expect(screen.queryByLabelText("Stop run")).toBeNull();
    expect(screen.queryByText("select model")).toBeNull();
    expect(screen.queryByTitle("Reasoning level")).toBeNull();
    expect(screen.queryByText("Goal")).toBeNull();
    expect(screen.queryByText("Design")).toBeNull();
    // Idle owner: writable without any Return to live demand (item 8).
    expect(screen.queryByText("Return to live")).toBeNull();
    // Permission mode stays available in claimable (not a runtime mutation).
    expect(screen.getByTitle("Execution mode: Auto")).toBeTruthy();
  });

  it("owner: existing full composer behavior unchanged", async () => {
    const onToggleGoal = vi.fn();
    render(<Composer {...baseProps({ executionAccess: { kind: "owner" }, onToggleGoal, goalMode: "off" })} />);
    const ta = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    expect(ta.disabled).toBe(false);
    expect(screen.getByText("select model")).toBeTruthy();
    expect(screen.getByTitle("Reasoning level")).toBeTruthy();
    expect(screen.getByText("Goal")).toBeTruthy();
    expect(screen.queryByText("Return to live")).toBeNull();
    expect(screen.getByTitle("Execution mode: Auto")).toBeTruthy();
    fireEvent.click(screen.getByText("Goal"));
    expect(onToggleGoal).toHaveBeenCalledTimes(1);
  });

  it("draft survives blocked → claimable without the composer unmounting", async () => {
    const { rerender } = render(<Composer {...baseProps({ executionAccess: { kind: "owner" } })} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Message Pi" }), "fix the parser");
    rerender(<Composer {...baseProps({ executionAccess: blockedAccess })} />);
    let ta = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    expect(ta.disabled).toBe(true);
    expect(ta.value).toBe("fix the parser");
    // A settles: same component instance, same draft, unlocked.
    rerender(<Composer {...baseProps({ executionAccess: { kind: "claimable" } })} />);
    ta = screen.getByRole("textbox", { name: "Message Pi" }) as HTMLTextAreaElement;
    expect(ta.disabled).toBe(false);
    expect(ta.value).toBe("fix the parser");
  });

  it("stream controls absent while streaming=false even for the owner (hidden-stream contract)", () => {
    render(<Composer {...baseProps({ executionAccess: { kind: "owner" }, streaming: false })} />);
    expect(screen.queryByLabelText("Stop run")).toBeNull();
    expect(screen.queryByText("steer")).toBeNull();
    expect(screen.queryByText("queue")).toBeNull();
  });
});
