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
    selectedPath: "/s/a",
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
    rerender(<SessionTabs {...baseProps({ preparingSelected: true })} />);
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

describe("SessionTabs selection vs execution independence", () => {
  const working = { path: "/s/a", state: "working" as const };

  it("1: selected A + execution A — both treatments on the same tab", () => {
    render(<SessionTabs {...baseProps({ execution: working })} />);
    const tab = screen.getByRole("tab", { name: "Alpha" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(tab.querySelector('[aria-label="Agent working"]')).not.toBeNull();
  });

  it("2: selected B + execution A — selection and ownership never move together", () => {
    render(<SessionTabs {...baseProps({ selectedPath: "/s/b", execution: working })} />);
    const a = screen.getByRole("tab", { name: "Alpha" });
    const b = screen.getByRole("tab", { name: "Beta" });
    expect(b.getAttribute("aria-selected")).toBe("true");
    expect(a.getAttribute("aria-selected")).toBe("false");
    expect(a.querySelector('[aria-label="Agent working"]')).not.toBeNull();
    expect(b.querySelector('[aria-label="Agent working"]')).toBeNull();
  });

  it("3: working execution gets the working marker", () => {
    render(<SessionTabs {...baseProps({ execution: working })} />);
    expect(screen.getByLabelText("Agent working")).toBeTruthy();
  });

  it("4: approval execution gets the approval marker (state-driven, not attention)", () => {
    render(<SessionTabs {...baseProps({ execution: { path: "/s/a", state: "approval" as const } })} />);
    expect(screen.getByLabelText("Agent needs approval")).toBeTruthy();
  });

  it("5: execution marker and attention marker coexist on one tab", () => {
    const attention = new Map([["/s/a", "unread"] as const]);
    render(<SessionTabs {...baseProps({ execution: working, attentionByPath: attention })} />);
    const tab = screen.getByRole("tab", { name: "Alpha" });
    expect(tab.querySelector('[aria-label="Agent working"]')).not.toBeNull();
    expect(tab.querySelector('[aria-label="Unread"]')).not.toBeNull();
  });

  it("6: no execution owner → no execution indicator anywhere", () => {
    render(<SessionTabs {...baseProps()} />);
    expect(screen.queryByLabelText("Agent working")).toBeNull();
    expect(screen.queryByLabelText("Agent waiting")).toBeNull();
    expect(screen.queryByLabelText("Agent needs approval")).toBeNull();
    expect(screen.queryByLabelText("Execution session")).toBeNull();
  });

  it("7: clicking the executing-but-not-selected tab activates it (execution ≠ selected)", () => {
    const onActivate = vi.fn();
    render(<SessionTabs {...baseProps({ selectedPath: "/s/b", execution: working, onActivate })} />);
    expect(screen.getByRole("tab", { name: "Alpha" }).getAttribute("aria-selected")).toBe("false");
    fireEvent.click(screen.getByRole("tab", { name: "Alpha" }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(TABS[0]);
  });
});
