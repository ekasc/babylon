// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import Sidebar from "./Sidebar";

function baseProps() {
  const noop = () => undefined;
  return {
    groups: [],
    treeOpen: false,
    canOpenTree: false,
    minimized: false,
    onToggleMinimize: noop,
    onOpenSettings: noop,
    onOpen: noop,
    onNew: noop,
    onSelectSpace: noop,
    projectFilter: "all",
    onProjectFilterChange: noop,
    onOpenFolder: noop,
    onOpenTree: noop,
    onSearch: noop,
    pinnedOrder: [],
    snoozed: {},
    archived: [],
    unread: [],
    onTogglePin: noop,
    onToggleSnooze: noop,
    onToggleUnread: noop,
    onToggleArchive: noop,
    onRename: noop,
    onCopy: noop,
    showArchived: false,
    onToggleShowArchived: noop,
    settled: {},
    onSettle: noop,
    onUnsettle: noop,
    liveAgents: [],
    allSpaceCwds: [],
    onOpenLiveAgent: noop,
    spaceCwds: [],
    onAddSpace: noop,
    onRemoveSpace: noop,
  };
}

function drag(handle: HTMLElement, fromX: number, moves: number[], end: "up" | "cancel" = "up") {
  act(() => {
    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: fromX });
    for (const x of moves) {
      window.dispatchEvent(Object.assign(new Event("pointermove", { bubbles: true }), { pointerId: 7, clientX: x }));
    }
    window.dispatchEvent(Object.assign(new Event(end === "up" ? "pointerup" : "pointercancel", { bubbles: true }), { pointerId: 7 }));
  });
}

describe("Sidebar resize handle", () => {
  afterEach(() => {
    cleanup();
    document.body.classList.remove("sidebar-resizing");
    window.localStorage.clear();
  });

  it("tracks 1:1 inside the bounds and persists on release", () => {
    const { container } = render(<Sidebar {...baseProps()} />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    const aside = container.querySelector("aside") as HTMLElement;
    expect(aside.style.width).toBe("256px");
    drag(handle, 100, [150]);
    expect(aside.style.width).toBe("306px");
    drag(handle, 150, [100]);
    expect(aside.style.width).toBe("256px");
    expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
    expect(window.localStorage.getItem("babylon:sidebar-width")).toBe("256");
  });

  it("resists past the bounds instead of hard-stopping, then snaps back", () => {
    const { container } = render(<Sidebar {...baseProps()} />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    const aside = container.querySelector("aside") as HTMLElement;
    act(() => {
      fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 100 });
      window.dispatchEvent(Object.assign(new Event("pointermove", { bubbles: true }), { pointerId: 7, clientX: 1000 }));
    });
    const resisted = parseFloat(aside.style.width);
    expect(resisted).toBeGreaterThan(560);
    expect(resisted).toBeLessThan(800);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pointerup", { bubbles: true }), { pointerId: 7 }));
    });
    expect(aside.style.width).toBe("560px");
    expect(window.localStorage.getItem("babylon:sidebar-width")).toBe("560");
  });

  it("cancelling never persists and always cleans up", () => {
    const { container } = render(<Sidebar {...baseProps()} />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    const aside = container.querySelector("aside") as HTMLElement;
    drag(handle, 100, [200], "cancel");
    expect(aside.style.width).toBe("356px");
    expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
    expect(window.localStorage.getItem("babylon:sidebar-width")).toBeNull();
  });

  it("ignores other pointers mid-drag", () => {
    const { container } = render(<Sidebar {...baseProps()} />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    const aside = container.querySelector("aside") as HTMLElement;
    act(() => {
      fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 100 });
      window.dispatchEvent(Object.assign(new Event("pointermove", { bubbles: true }), { pointerId: 99, clientX: 500 }));
    });
    expect(aside.style.width).toBe("256px");
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pointerup", { bubbles: true }), { pointerId: 7 }));
    });
  });
});
