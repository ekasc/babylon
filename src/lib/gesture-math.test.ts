import { describe, expect, it } from "vitest";
import { clampHard, clampWithRubberband, projectMomentum, releaseVelocity, rubberband } from "./gesture-math";

describe("projectMomentum", () => {
  it("projects flick distance with exponential decay", () => {
    // 1000px/s flick at the standard rate travels ~499px past release.
    expect(projectMomentum(1000)).toBeCloseTo(499, 0);
    expect(projectMomentum(0)).toBe(0);
    expect(projectMomentum(-500)).toBeCloseTo(-249.5, 0);
  });

  it("snappier rates project shorter", () => {
    expect(projectMomentum(1000, 0.99)).toBeCloseTo(99, 0);
  });
});

describe("rubberband", () => {
  it("passes small overshoots nearly through and resists large ones", () => {
    const small = rubberband(10, 300);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(10);
    const large = rubberband(1000, 300);
    expect(large).toBeGreaterThan(0);
    expect(large).toBeLessThan(300);
  });

  it("is antisymmetric and total at zero", () => {
    expect(rubberband(0, 300)).toBe(0);
    expect(rubberband(50, 300)).toBeCloseTo(-rubberband(-50, 300), 10);
  });

  it("grows monotonically toward the dimension asymptote", () => {
    const a = rubberband(100, 300);
    const b = rubberband(500, 300);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(300);
  });
});

describe("clampWithRubberband", () => {
  it("passes interior values through untouched (1:1 tracking)", () => {
    expect(clampWithRubberband(400, 220, 560, 340)).toBe(400);
    expect(clampWithRubberband(220, 220, 560, 340)).toBe(220);
    expect(clampWithRubberband(560, 220, 560, 340)).toBe(560);
  });

  it("resists past the bounds instead of hard-stopping", () => {
    const over = clampWithRubberband(660, 220, 560, 340);
    expect(over).toBeGreaterThan(560);
    expect(over).toBeLessThan(660);
    const under = clampWithRubberband(120, 220, 560, 340);
    expect(under).toBeGreaterThan(120);
    expect(under).toBeLessThan(220);
  });

  it("snaps back to the hard bound on release", () => {
    expect(clampHard(clampWithRubberband(660, 220, 560, 340), 220, 560)).toBe(560);
    expect(clampHard(clampWithRubberband(120, 220, 560, 340), 220, 560)).toBe(220);
  });
});

describe("releaseVelocity", () => {
  it("computes px/s from the last two samples", () => {
    expect(releaseVelocity([{ x: 0, t: 0 }, { x: 100, t: 100 }])).toBe(1000);
  });

  it("returns 0 without usable history", () => {
    expect(releaseVelocity([])).toBe(0);
    expect(releaseVelocity([{ x: 5, t: 10 }])).toBe(0);
    expect(releaseVelocity([{ x: 0, t: 10 }, { x: 10, t: 10 }])).toBe(0);
  });
});
