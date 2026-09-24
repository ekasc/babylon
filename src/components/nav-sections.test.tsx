// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionTabs, type TabItem } from "./SessionTabs";
import { SessionHistoryMenu } from "./SessionHistoryMenu";
import { AgentsSection } from "./AgentsSection";
import type { ExecutionTree } from "../lib/execution-tree";

afterEach(() => cleanup());

const tabs: TabItem[] = [
  { path: "/s/a", cwd: "/x", title: "Alpha" },
  { path: "/s/b", cwd: "/y", title: "Beta" },
];

function strip(props?: Partial<Parameters<typeof SessionTabs>[0]>) {
  return (
    <SessionTabs
      tabs={tabs}
      selectedPath="/s/a"
      attentionByPath={new Map([["/s/b", "unread"]])}
      onActivate={() => {}}
      onClose={() => {}}
      onNew={() => {}}
      historyMenu={null}
      {...props}
    />
  );
}

describe("SessionTabs", () => {
  it("marks the active tab and shows attention", () => {
    render(strip());
    expect(screen.getByRole("tab", { name: "Alpha" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Beta" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByLabelText("Unread")).toBeTruthy();
  });

  it("click activates, × closes, middle-click closes", async () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(strip({ onActivate, onClose }));
    await user.click(screen.getByRole("tab", { name: "Beta" }));
    expect(onActivate).toHaveBeenCalledWith(tabs[1]);
    await user.click(screen.getByLabelText("Close Beta"));
    expect(onClose).toHaveBeenCalledWith("/s/b");
    const tab = screen.getByRole("tab", { name: "Alpha" });
    tab.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(onClose).toHaveBeenCalledWith("/s/a");
  });

  it("+ opens the new-session flow", async () => {
    const onNew = vi.fn();
    render(strip({ onNew }));
    await userEvent.click(screen.getByLabelText("New session"));
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});

describe("SessionHistoryMenu", () => {
  const entries = [
    { path: "/s/a", cwd: "/x", title: "Alpha", projectName: "ex", mtime: Date.now(), open: true },
    { path: "/s/old", cwd: "/x", title: "Old", projectName: "ex", mtime: 1, open: false },
  ];
  it("reopens a closed session from history", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<SessionHistoryMenu entries={entries} onOpen={onOpen} />);
    await user.click(screen.getByLabelText("Session history"));
    await user.click(screen.getByText("Old"));
    expect(onOpen).toHaveBeenCalledWith(entries[1]);
  });
});
describe("AgentsSection", () => {
  const tree = (over: Partial<ExecutionTree> = {}): ExecutionTree => ({
    cwd: "/babylon",
    sessionFile: "/babylon/s1.jsonl",
    sessionId: "s1",
    title: "Auth refactor",
    projectName: "babylon",
    state: "working",
    attention: "none",
    children: [],
    ...over,
  });

  it("renders one root row, no count, Idle when empty", () => {
    const { rerender } = render(
      <AgentsSection trees={[tree()]} selectedPath={null} onOpenRoot={() => {}} />
    );
    expect(screen.getByText("Auth refactor")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.queryByText(/Agents \(/)).toBeNull(); // ambiguous count removed
    rerender(<AgentsSection trees={[]} selectedPath={null} onOpenRoot={() => {}} />);
    expect(screen.queryByText("Auth refactor")).toBeNull();
    expect(screen.getByText("Idle.")).toBeTruthy();
  });

  it("nests children under their root without extra project identity", () => {
    render(
      <AgentsSection
        trees={[
          tree({
            children: [
              { key: "t1", kind: "thread", label: "Explore middleware", statusLabel: "Running", state: "working" },
              { key: "w1", kind: "workflow", label: "Release checks", statusLabel: "Paused", state: "waiting" },
            ],
          }),
        ]}
        selectedPath={null}
        onOpenRoot={() => {}}
      />
    );
    expect(screen.getByText("Explore middleware")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Release checks")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    // Project identity appears once (on the root), never per child.
    expect(screen.getAllByText("babylon")).toHaveLength(1);
    // Child rows are monitoring-only: no button/click surface.
    expect(screen.queryByRole("button", { name: /Explore middleware/ })).toBeNull();
  });

  it("renders two project roots", () => {
    render(
      <AgentsSection
        trees={[tree(), tree({ cwd: "/rot", sessionFile: "/rot/s9.jsonl", sessionId: "s9", title: "Screen parser", projectName: "rot" })]}
        selectedPath={null}
        onOpenRoot={() => {}}
      />
    );
    expect(screen.getByText("Auth refactor")).toBeTruthy();
    expect(screen.getByText("Screen parser")).toBeTruthy();
  });

  it("selected/viewed is a view highlight only; an executing root renders even when another session is viewed", async () => {
    const onOpenRoot = vi.fn();
    render(
      <AgentsSection
        trees={[tree()]}
        selectedPath="/babylon/other.jsonl" // viewed session is NOT the root
        onOpenRoot={onOpenRoot}
      />
    );
    // Membership never depends on the viewed session: the executing root stays.
    expect(screen.getByText("Auth refactor")).toBeTruthy();
    await userEvent.click(screen.getByText("Auth refactor"));
    expect(onOpenRoot).toHaveBeenCalledTimes(1);
    expect(onOpenRoot.mock.calls[0]?.[0]).toMatchObject({ sessionId: "s1" });
  });
});
