import { describe, expect, it } from "vitest";
import { canTrackDrawerMove, emptyDrawerGesture } from "./drawerGesture";

describe("drawer gesture guard", () => {
  it("ignores plain hover movement with no matching pointerdown", () => {
    expect(canTrackDrawerMove(emptyDrawerGesture(), { pointerId: 1, pointerType: "mouse", buttons: 0 })).toBe(false);
  });

  it("cancels mouse tracking after the primary button is released", () => {
    const state = { startX: 100, startY: 50, armed: true, active: false, pointerId: 3 };
    expect(canTrackDrawerMove(state, { pointerId: 3, pointerType: "mouse", buttons: 0 })).toBe(false);
    expect(canTrackDrawerMove(state, { pointerId: 3, pointerType: "mouse", buttons: 1 })).toBe(true);
  });

  it("rejects movement from another pointer", () => {
    const state = { startX: 100, startY: 50, armed: true, active: false, pointerId: 3 };
    expect(canTrackDrawerMove(state, { pointerId: 4, pointerType: "touch", buttons: 1 })).toBe(false);
  });
});
