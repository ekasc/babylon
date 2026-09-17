// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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