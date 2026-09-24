// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { bridge, type ApprovalRequest } from "../bridge";
import { ApprovalGate } from "./ApprovalGate";

vi.mock("../bridge", () => ({
  bridge: {
    onApprovalRequested: vi.fn(() => vi.fn()),
    onApprovalCleared: vi.fn(() => vi.fn()),
    permissionsResolveApproval: vi.fn(),
  },
}));

const request: ApprovalRequest = {
  id: "approval-1",
  risk: "high",
  action: { category: "git_push", description: "Push changes" },
};

function openGate() {
  render(<ApprovalGate />);
  act(() => (vi.mocked(bridge.onApprovalRequested).mock.calls[0]?.[0] ?? (() => { throw new Error("missing call"); }))(request));
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ApprovalGate", () => {
  it.each([
    ["Allow once", "allow_once"],
    ["Allow for session", "allow_session"],
    ["Always allow", "allow_always"],
    ["Deny", "deny"],
  ])("keeps %s pending until acknowledged", async (label, choice) => {
    let acknowledge!: (value: { ok: boolean }) => void;
    vi.mocked(bridge.permissionsResolveApproval).mockReturnValueOnce(
      new Promise((resolve) => { acknowledge = resolve; }),
    );
    openGate();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(bridge.permissionsResolveApproval).toHaveBeenCalledWith(request.id, choice);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Sending decision…");
    expect(screen.getByRole("button", { name: "Deny" }).matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(bridge.permissionsResolveApproval).toHaveBeenCalledTimes(1);
    await act(async () => acknowledge({ ok: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a delivery error and allows retry", async () => {
    vi.mocked(bridge.permissionsResolveApproval)
      .mockRejectedValueOnce(new Error("Daemon disconnected"))
      .mockResolvedValueOnce({ ok: true });
    openGate();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Daemon disconnected");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" }).matches(":disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("retains a decision that was not accepted", async () => {
    vi.mocked(bridge.permissionsResolveApproval).mockResolvedValueOnce({ ok: false });
    openGate();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not accepted");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not restore a cleared request when delivery later fails", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(bridge.permissionsResolveApproval).mockReturnValueOnce(
      new Promise((_resolve, fail) => { reject = fail; }),
    );
    openGate();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    act(() => (vi.mocked(bridge.onApprovalCleared).mock.calls[0]?.[0] ?? (() => { throw new Error("missing call"); }))({ id: request.id }));
    await act(async () => reject(new Error("Disconnected")));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
