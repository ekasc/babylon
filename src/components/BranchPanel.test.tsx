// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import BranchPanel from "./BranchPanel";

const { getHistory } = vi.hoisted(() => ({
  getHistory: vi.fn(async () => ({ turns: [], leafId: null, hasBranches: false })),
}));
vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, getHistory } };
});

afterEach(() => {
  cleanup();
  getHistory.mockClear();
});

const base = {
  onClose: () => {},
  onRollback: () => {},
  onUndoRollback: () => {},
  onForkCurrent: () => {},
  toast: () => {},
  refreshToken: 0,
};

describe("BranchPanel addressing", () => {
  it("renders empty history without fetching when nothing is viewed", () => {
    render(<BranchPanel {...base} sessionFile={null} />);
    expect(getHistory).not.toHaveBeenCalled();
  });

  it("reads history only for the addressed session", async () => {
    render(<BranchPanel {...base} sessionFile="/tmp/viewed.jsonl" />);
    expect(getHistory).toHaveBeenCalledWith("/tmp/viewed.jsonl");
  });
});
