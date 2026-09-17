// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionMeta } from "../bridge";
import { ThreadMenu } from "./Sidebar";

afterEach(() => cleanup());

/**
 * Babylon's contract with the Base UI menu primitive behind the sidebar
 * thread context menu: desktop keyboard expectations (ArrowUp/Down,
 * Enter/Space, Escape), disabled items skipped, submenu opens, focus
 * returns, correct menu roles.
 */
const SESSION: SessionMeta = {
  id: "s1",
  path: "/tmp/s1",
  cwd: "/tmp",
  name: "Chat one",
  mtime: Date.now(),
};

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    x: 100,
    y: 100,
    session: SESSION,
    pinned: false,
    snoozedUntil: undefined,
    unread: false,
    archived: false,
    settled: false,
    isActive: false,
    canSettle: true,
    onClose: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleSnooze: vi.fn(),
    onToggleUnread: vi.fn(),
    onToggleArchive: vi.fn(),
    onSettle: vi.fn(),
    onUnsettle: vi.fn(),
    onRename: vi.fn(),
    onCopy: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

describe("ThreadMenu", () => {
  it("renders menu roles and activates an item with Enter", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<ThreadMenu {...props} />);
    const menu = screen.getByRole("menu", { name: /Chat actions/ });
    expect(menu).toBeTruthy();
    const items = screen.getAllByRole("menuitem");
    expect(items.length).toBeGreaterThan(3);
    // Keyboard: focus the menu, ArrowDown highlights the first item, Enter picks it.
    (menu as HTMLElement).focus();
    await user.keyboard("{ArrowDown}");
    const pin = screen.getByText("Pin chat");
    await waitFor(() => expect(document.activeElement).toBe(pin));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(props.onTogglePin).toHaveBeenCalled());
    expect(props.onClose).toHaveBeenCalled();
  });

  it("Escape closes without acting", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<ThreadMenu {...props} />);
    expect(screen.getByRole("menu", { name: /Chat actions/ })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(props.onTogglePin).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it("skips the disabled Settle chat item during keyboard navigation", async () => {
    const props = baseProps({ canSettle: false });
    const user = userEvent.setup();
    render(<ThreadMenu {...props} />);
    const settle = screen.getByText("Settle chat");
    expect(settle.getAttribute("aria-disabled")).toBe("true");
    // Walk the whole menu; focus must never land on the disabled item.
    (screen.getByRole("menu", { name: /Chat actions/ }) as HTMLElement).focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitem"));
    for (let i = 0; i < 20; i++) {
      await user.keyboard("{ArrowDown}");
      expect(document.activeElement?.textContent).not.toBe("Settle chat");
    }
  });

  it("opens the Snooze submenu from the keyboard and picks a preset", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<ThreadMenu {...props} />);
    (screen.getByRole("menu", { name: /Chat actions/ }) as HTMLElement).focus();
    // Pin chat, then the Snooze submenu trigger, then open it rightwards.
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Pin chat")));
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Snooze›"));
    await user.keyboard("{ArrowRight}");
    const preset = await screen.findByRole("menuitem", { name: "Later today" });
    // Focus stays on the trigger when the submenu opens; ArrowDown enters it.
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.activeElement).toBe(preset));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(props.onToggleSnooze).toHaveBeenCalledWith("/tmp/s1", expect.any(Number)));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("archived chats show the short unarchive/delete menu", async () => {
    const props = baseProps({ archived: true });
    render(<ThreadMenu {...props} />);
    const items = screen.getAllByRole("menuitem");
    expect(items.map((el) => el.textContent)).toEqual(["Unarchive chat", "Delete chat"]);
  });
});
