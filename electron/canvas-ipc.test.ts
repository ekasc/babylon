import { describe, expect, it, vi } from "vitest";
import { registerCanvasIpc, type SketchCrop } from "./canvas-ipc";
import type { AgentAction } from "./permissions";

const crops: SketchCrop[] = [{ regionId: "r1", dataUrl: "data:image/png;base64,AAAA" }];

function harness(options: { approved: boolean }) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const approval = vi.fn(async (_action: AgentAction) => options.approved);
  const classify = vi.fn(async () => ({
    r1: { role: "process" as const, label: "Cart", confidence: 0.9 },
  }));
  // A stand-in for ipcMain.handle: capturing the listener is all this needs, and
  // the cast is because Electron's event type cannot be constructed in a test.
  const handle: Parameters<typeof registerCanvasIpc>[0] = (channel, listener) => {
    handlers.set(channel, listener as unknown as (...args: unknown[]) => unknown);
  };
  registerCanvasIpc(handle, {
    getWindow: () => null,
    classifyRegions: classify,
    requestEgressApproval: approval,
  });
  return {
    approval,
    classify,
    // The first argument an ipcMain listener receives is the event.
    call: (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!({}, ...args)),
  };
}

const lastAction = (approval: ReturnType<typeof vi.fn>): AgentAction =>
  approval.mock.calls[approval.mock.calls.length - 1][0] as AgentAction;

describe("sketch egress", () => {
  it("asks before a drawing leaves the machine", async () => {
    const h = harness({ approved: true });
    await h.call("pideck:canvas-classify", "/work/project", "plan", crops);

    expect(h.approval).toHaveBeenCalledTimes(1);
    expect(lastAction(h.approval).category).toBe("network_access");
    expect(lastAction(h.approval).description).toContain("1 hand-drawn shape");
  });

  it("scopes the request to the scene being read", async () => {
    const h = harness({ approved: true });
    await h.call("pideck:canvas-classify", "/work/other", "flow", crops);

    // The path is what scopes an "allow" rule, so approving once cannot open
    // network access for everything else.
    expect(lastAction(h.approval).paths).toEqual(["/work/other/.pi/canvas/flow.canvas"]);
  });

  it("says how many shapes were drawn", async () => {
    const h = harness({ approved: true });
    await h.call("pideck:canvas-classify", "/work/project", "plan", [
      ...crops,
      { regionId: "r2", dataUrl: "data:image/png;base64,BBBB" },
    ]);
    expect(lastAction(h.approval).description).toContain("2 hand-drawn shapes");
  });

  it("sends nothing when the egress is not approved", async () => {
    const h = harness({ approved: false });
    await expect(h.call("pideck:canvas-classify", "/work/project", "plan", crops)).rejects.toThrow(
      "Sending the sketch to the image model was not approved."
    );
    expect(h.classify).not.toHaveBeenCalled();
  });

  it("classifies once approved", async () => {
    const h = harness({ approved: true });
    const readings = await h.call("pideck:canvas-classify", "/work/project", "plan", crops);

    expect(h.classify).toHaveBeenCalledWith("/work/project", crops);
    expect(readings).toEqual({ r1: { role: "process", label: "Cart", confidence: 0.9 } });
  });
});
