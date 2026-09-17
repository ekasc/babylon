// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionTabs, type TabItem } from "./SessionTabs";
import { SessionHistoryMenu } from "./SessionHistoryMenu";
import { AgentsSection, type AgentRow } from "./AgentsSection";

afterEach(() => cleanup());

const tabs: TabItem[] = [
  { path: "/s/a", cwd: "/x", title: "Alpha" },
  { path: "/s/b", cwd: "/y", title: "Beta" },
];

function strip(props?: Partial<Parameters<typeof SessionTabs>[0]>) {
  return (
    <SessionTabs
      tabs={tabs}
      activePath="/s/a"
      allCwds={["/x", "/y"]}
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

function agentRow(over: Partial<AgentRow["agent"]> = {}): AgentRow {
  return {
    agent: {
      path: "/s/a",
      cwd: "/x",
      execution: "working",
      attention: "none",
      mtime: 1,
      ...over,
    },
    title: "Alpha",
    projectName: "ex",
  };
}

describe("AgentsSection", () => {
  it("shows live agents with state, hides when idle", () => {
    const { rerender } = render(
      <AgentsSection rows={[agentRow()]} activePath={null} allCwds={["/x"]} onOpen={() => {}} />
    );
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    rerender(<AgentsSection rows={[]} activePath={null} allCwds={["/x"]} onOpen={() => {}} />);
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Idle.")).toBeTruthy();
  });

  it("clicking an agent activates its session", async () => {
    const onOpen = vi.fn();
    const row = agentRow();
    render(<AgentsSection rows={[row]} activePath={null} allCwds={["/x"]} onOpen={onOpen} />);
    await userEvent.click(screen.getByText("Alpha"));
    expect(onOpen).toHaveBeenCalledWith(row);
  });
});
