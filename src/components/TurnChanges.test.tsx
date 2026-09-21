// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TurnChanges } from "./TurnChanges";

const { getTurnChanges } = vi.hoisted(() => ({
  getTurnChanges: vi.fn(async () => ({
    userEntryId: "e1",
    files: [{ path: "src/a.ts", kind: "modified", additions: 5, deletions: 3 }],
    totals: { files: 8, additions: 5, deletions: 3 },
    exclusions: [],
  })),
}));
vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, getTurnChanges } };
});

afterEach(() => {
  cleanup();
  getTurnChanges.mockClear();
});

// 8 changed files: over the auto-expand limit, so the row stays collapsed.
const TURN = {
  entryId: "e1",
  parentUserEntryId: null,
  index: 0,
  depth: 0,
  text: "do it",
  response: "done",
  onActivePath: true,
  current: true,
  branchCount: 1,
  changedCount: 8,
  checkpointAvailable: true,
  rollbackAvailable: true,
};

describe("TurnChanges header totals", () => {
  it("shows real +/- on the collapsed row even when it does not auto-expand", async () => {
    render(<TurnChanges turn={TURN} isLatest />);
    const row = screen.getByRole("button");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(getTurnChanges).toHaveBeenCalledWith("e1"));
    expect(screen.getByText("8 files changed")).toBeTruthy();
    expect(screen.getByText("+5")).toBeTruthy();
    expect(screen.getByText("−3")).toBeTruthy();
  });

  it("never shows the placeholder +0 −0 before totals arrive", () => {
    render(<TurnChanges turn={TURN} isLatest />);
    expect(screen.queryByText("+0")).toBeNull();
    expect(screen.queryByText("−0")).toBeNull();
  });
});

describe("TurnChanges load failure", () => {
  // changedCount <= 5 auto-expands on the latest turn, so the body (and
  // the failure) renders without an extra click.
  const SMALL = { ...TURN, entryId: "e2", changedCount: 2 };

  it("shows a retryable error instead of spinning on loading forever", async () => {
    getTurnChanges.mockRejectedValueOnce(new Error("snapshot unavailable"));
    render(<TurnChanges turn={SMALL} isLatest />);
    await waitFor(() => expect(getTurnChanges).toHaveBeenCalledWith("e2"));
    expect(await screen.findByText("snapshot unavailable")).toBeTruthy();
    expect(screen.queryByText("loading changes…")).toBeNull();
  });

  it("retry refetches and renders the file list on success", async () => {
    getTurnChanges.mockRejectedValueOnce(new Error("snapshot unavailable"));
    render(<TurnChanges turn={SMALL} isLatest />);
    const retry = await screen.findByRole("button", { name: /retry/i });
    getTurnChanges.mockResolvedValueOnce({
      userEntryId: "e2",
      files: [{ path: "src/b.ts", kind: "modified", additions: 1, deletions: 1 }],
      totals: { files: 1, additions: 1, deletions: 1 },
      exclusions: [],
    });
    fireEvent.click(retry);
    expect(await screen.findByText("src/b.ts")).toBeTruthy();
    expect(screen.queryByText("snapshot unavailable")).toBeNull();
  });
});