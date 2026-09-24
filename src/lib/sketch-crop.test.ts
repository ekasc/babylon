import { describe, expect, it } from "vitest";
import type { CanvasInk } from "./canvas-dsl";
import { cropScale, regionCrop, strokesWithin } from "./sketch-crop";
import { readSketch, type Region } from "./sketch-geometry";

const box = (x: number, y: number, width: number, height: number): string =>
  `M${x} ${y} L${x + width} ${y} L${x + width} ${y + height} L${x} ${y + height} Z`;

const ink = (id: string, d: string): CanvasInk => ({ id, d });

const region = (x: number, y: number, width: number, height: number, id = "r1"): Region => ({
  id,
  inkIds: [],
  shape: "rect",
  bounds: { x, y, width, height },
  contains: [],
  parent: null,
});

describe("choosing a region's strokes", () => {
  it("keeps what is inside and drops what is outside", () => {
    const inside = ink("in", box(10, 10, 80, 40));
    const outside = ink("out", box(400, 400, 80, 40));
    expect(strokesWithin([inside, outside], region(0, 0, 100, 60)).map((element) => element.id)).toEqual(["in"]);
  });

  it("drops a stroke that only passes through", () => {
    const through = ink("line", "M-50 30 L200 30");
    expect(strokesWithin([through], region(0, 0, 100, 60))).toEqual([]);
  });

  it("drops a stroke it cannot read", () => {
    expect(strokesWithin([ink("arc", "M0 0 A10 10 0 0 1 20 20")], region(-10, -10, 100, 60))).toEqual([]);
  });

  it("keeps a nested region's strokes, so a container crop shows what it holds", () => {
    const drawings = [ink("outer", box(0, 0, 300, 200)), ink("inner", box(50, 50, 100, 60))];
    const outer = readSketch(drawings).regions.find((candidate) => candidate.id === "r1")!;
    // The container's own outline plus the shape drawn inside it, so the model
    // sees what the container holds when it is asked what the container is.
    expect(strokesWithin(drawings, outer).map((element) => element.id)).toEqual(["outer", "inner"]);
  });
});

describe("building a crop", () => {
  it("frames the region with padding", () => {
    const crop = regionCrop([], region(100, 200, 120, 60), { padding: 12 });
    expect(crop.svg).toContain('viewBox="88 188 144 84"');
    expect(crop.regionId).toBe("r1");
  });

  it("scales a small region up so handwriting stays readable", () => {
    const small = regionCrop([], region(0, 0, 96, 96), { padding: 12 });
    expect(Math.max(small.width, small.height)).toBeGreaterThanOrEqual(320);
    expect(cropScale(region(0, 0, 96, 96), 12)).toBeCloseTo(320 / 120, 5);
  });

  it("does not shrink a large region and does not scale without limit", () => {
    expect(cropScale(region(0, 0, 2000, 1000), 12)).toBe(1);
    expect(cropScale(region(0, 0, 1, 1), 0)).toBe(4);
  });

  it("reports a pixel size that matches the markup", () => {
    const crop = regionCrop([], region(0, 0, 200, 100));
    expect(crop.svg).toContain(`width="${crop.width}"`);
    expect(crop.svg).toContain(`height="${crop.height}"`);
  });

  it("draws dark strokes on white whatever the ink colour was", () => {
    const crop = regionCrop([ink("a", box(0, 0, 90, 50))], region(0, 0, 100, 60));
    expect(crop.svg).toContain('fill="#ffffff"');
    expect(crop.svg).toContain('stroke="#111111"');
    expect(crop.svg).toContain('fill="none"');
  });

  it("includes the region's own outline", () => {
    const outline = ink("outline", box(0, 0, 100, 60));
    expect(regionCrop([outline], region(0, 0, 100, 60)).svg).toContain(box(0, 0, 100, 60));
  });

  it("escapes path data so a scene file cannot inject markup", () => {
    const crop = regionCrop([ink("a", "M0 0 L10 0 &")], region(0, 0, 100, 60));
    expect(crop.svg).toContain("&amp;");
    expect(crop.svg).not.toContain("& ");
  });

  it("leaves out strokes belonging to a different shape", () => {
    const sketch = readSketch([ink("a", box(0, 0, 100, 60)), ink("b", box(300, 0, 100, 60))]);
    const first = sketch.regions[0];
    if (!first) throw new Error("missing region");
    const crop = regionCrop([ink("a", box(0, 0, 100, 60)), ink("b", box(300, 0, 100, 60))], first);
    const strokes = crop.svg.match(/<path/g) ?? [];
    expect(strokes).toHaveLength(1);
  });
});
