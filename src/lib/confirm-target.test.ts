import { describe, expect, it, vi } from "vitest";
import { captureTargetThen } from "./confirm-target";

describe("captureTargetThen (confirm-before-mutate, I7)", () => {
  it("captures the target BEFORE the dialog; navigating during confirm cannot retarget", async () => {
    // The viewed session at click time.
    let viewed = "/sessions/a.jsonl";
    const run = vi.fn(async (_target: string) => undefined);
    const confirm = vi.fn(async () => {
      // User navigates while the modal is open.
      viewed = "/sessions/b.jsonl";
      return true;
    });
    const result = await captureTargetThen(() => viewed, confirm, run);
    expect(result).not.toBeNull();
    expect(run).toHaveBeenCalledWith("/sessions/a.jsonl");
    expect(run).not.toHaveBeenCalledWith("/sessions/b.jsonl");
  });

  it("returns null without running when there is no target", async () => {
    const run = vi.fn(async (_t: string) => "x");
    const confirm = vi.fn(async () => true);
    expect(await captureTargetThen(() => null, confirm, run)).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("returns null without running when the user declines", async () => {
    const run = vi.fn(async (_t: string) => "x");
    expect(await captureTargetThen(() => "/sessions/a.jsonl", async () => false, run)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
