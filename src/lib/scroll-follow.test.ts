import { describe, expect, it } from "vitest";
import { isContinuousScroll, isScrollKey, shouldBreakFollow } from "./scroll-follow";

describe("shouldBreakFollow", () => {
  it("holds follow on isolated jumps with no gesture (anchoring, layout shifts)", () => {
    expect(shouldBreakFollow({ gestured: false, continuous: false })).toBe(false);
  });

  it("breaks on fresh input gestures and on continuous streams", () => {
    expect(shouldBreakFollow({ gestured: true, continuous: false })).toBe(true);
    expect(shouldBreakFollow({ gestured: false, continuous: true })).toBe(true);
    expect(shouldBreakFollow({ gestured: true, continuous: true })).toBe(true);
  });
});

describe("isContinuousScroll", () => {
  it("treats rapid successive movement as one stream (momentum, drags)", () => {
    expect(isContinuousScroll({ at: 1000, top: 500 }, 1050, 480)).toBe(true);
  });

  it("rejects pauses and stationary events", () => {
    expect(isContinuousScroll({ at: 1000, top: 500 }, 1200, 480)).toBe(false);
    expect(isContinuousScroll({ at: 1000, top: 500 }, 1050, 500)).toBe(false);
  });
});

describe("isScrollKey", () => {
  it("matches transcript-scroll keys only", () => {
    for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", " ", "Home", "End"]) {
      expect(isScrollKey(key)).toBe(true);
    }
    expect(isScrollKey("Enter")).toBe(false);
    expect(isScrollKey("a")).toBe(false);
  });
});
