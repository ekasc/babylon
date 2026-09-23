// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionTabs, type TabItem } from "./SessionTabs";

afterEach(() => cleanup());

const TABS: TabItem[] = [
  { path: "/s/a", cwd: "/proj", title: "Alpha" },
  { path: "/s/b", cwd: "/proj", title: "Beta" },
  { path: "/s/c", cwd: "/proj", title: "Gamma" },
];

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    tabs: TABS,
    activePath: "/s/a",
    attentionByPath: new Map(),
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    historyMenu: null,
    ...overrides,
  };
}

describe("SessionTabs quick-switch", () => {
  it("activates the nth tab on mod+digit", () => {
    const onActivate = vi.fn();
    render(<SessionTabs {...baseProps({ onActivate })} />);
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(onActivate).toHaveBeenCalledWith(TABS[1]);
  });

  it("ignores out-of-range digits and the active tab", () => {
    const onActivate = vi.fn();
    render(<SessionTabs {...baseProps({ onActivate })} />);
    fireEvent.keyDown(window, { key: "9", metaKey: true });
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("hints the shortcut in tab titles", () => {
    render(<SessionTabs {...baseProps({})} />);
    const tab = screen.getByRole("tab", { name: "Beta" });
    expect(tab.getAttribute("title")).toMatch(/Beta \(.+2\)/);
  });

  it("shows a readiness spinner on the active tab while preparing", () => {
    const { rerender } = render(<SessionTabs {...baseProps({})} />);
    expect(screen.queryByLabelText("Preparing session")).toBeNull();
    rerender(<SessionTabs {...baseProps({ preparingActive: true })} />);
    const tab = screen.getByRole("tab", { name: "Alpha" });
    expect(tab.querySelector('[aria-label="Preparing session"]')).not.toBeNull();
  });

  it("renders no per-tab project icons (strip is project-scoped)", () => {
    const { container } = render(<SessionTabs {...baseProps({})} />);
    // Tabs are title + attention dot + close × only; any svg would be a
    // project icon (this fails if ProjectIcon returns to the strip).
    expect(container.querySelectorAll("svg").length).toBe(0);
  });
});
