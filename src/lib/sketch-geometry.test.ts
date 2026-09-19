import { describe, expect, it } from "vitest";
import type { CanvasInk } from "./canvas-dsl";
import {
  boundsOfPoints,
  isClosed,
  parseStroke,
  pathLength,
  polygonArea,
  readSketch,
  shapeOfRegion,
} from "./sketch-geometry";

const box = (x: number, y: number, width: number, height: number): string =>
  `M${x} ${y} L${x + width} ${y} L${x + width} ${y + height} L${x} ${y + height} Z`;

const circle = (cx: number, cy: number, radius: number): string =>
  Array.from({ length: 25 }, (_, index) => {
    const angle = (index / 24) * Math.PI * 2;
    const x = (cx + Math.cos(angle) * radius).toFixed(2);
    const y = (cy + Math.sin(angle) * radius).toFixed(2);
    return `${index === 0 ? "M" : "L"}${x} ${y}`;
  }).join(" ");

const diamond = "M50 0 L100 50 L50 100 L0 50 Z";

const ink = (id: string, d: string): CanvasInk => ({ id, d });

describe("path parsing", () => {
  it("reads absolute and relative line commands", () => {
    expect(parseStroke("M0 0 L10 0 L10 10")).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(parseStroke("m0 0 l10 0 l0 10")).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it("treats pairs after a move as line-to", () => {
    expect(parseStroke("M0 0 10 0 10 10")).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it("reads horizontal, vertical and close commands", () => {
    expect(parseStroke("M0 0 H10 V10 Z")).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 0 },
    ]);
  });

  it("reads numbers that run together", () => {
    expect(parseStroke("M0 0L10-5")).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: -5 },
    ]);
  });

  it("flattens curves into points on the path", () => {
    const cubic = parseStroke("M0 0 C0 50 100 50 100 0")!;
    expect(cubic.length).toBe(9);
    expect(cubic[cubic.length - 1]).toEqual({ x: 100, y: 0 });
    expect(cubic[4].y).toBeGreaterThan(30);

    const quadratic = parseStroke("M0 0 Q50 100 100 0")!;
    expect(quadratic.length).toBe(9);
    expect(quadratic[4].y).toBeCloseTo(50, 5);
  });

  it("returns null for a stroke it cannot be trusted to read", () => {
    expect(parseStroke("M0 0 A10 10 0 0 1 20 20")).toBeNull();
    expect(parseStroke("")).toBeNull();
    expect(parseStroke("M0 0")).toBeNull();
  });
});

describe("stroke measures", () => {
  it("measures a box", () => {
    const points = parseStroke(box(0, 0, 100, 50))!;
    expect(boundsOfPoints(points)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(polygonArea(points)).toBe(5000);
    expect(pathLength(points)).toBeCloseTo(300, 5);
  });

  it("calls a loop closed and a line open", () => {
    expect(isClosed(parseStroke(box(0, 0, 200, 100))!, 0.08)).toBe(true);
    expect(isClosed(parseStroke("M0 0 L200 0")!, 0.08)).toBe(false);
    expect(isClosed(parseStroke("M0 0 L20 0")!, 0.08)).toBe(false);
  });

  it("tells a box from an ellipse from a scribble", () => {
    expect(shapeOfRegion(parseStroke(box(0, 0, 100, 60))!)).toBe("rect");
    expect(shapeOfRegion(parseStroke(circle(50, 50, 40))!)).toBe("ellipse");
    expect(shapeOfRegion(parseStroke(diamond)!)).toBeNull();
  });
});

describe("reading a sketch", () => {
  it("finds a drawn box", () => {
    const sketch = readSketch([ink("a", box(10, 10, 100, 60))]);
    expect(sketch.regions).toHaveLength(1);
    expect(sketch.regions[0]).toMatchObject({ id: "r1", shape: "rect", parent: null, contains: [], inkIds: ["a"] });
    expect(sketch.regions[0].bounds).toEqual({ x: 10, y: 10, width: 100, height: 60 });
    expect(sketch.connectors).toEqual([]);
    expect(sketch.loose).toEqual([]);
  });

  it("numbers regions in reading order so ids are stable", () => {
    const sketch = readSketch([
      ink("a", box(300, 10, 80, 40)),
      ink("b", box(10, 200, 80, 40)),
      ink("c", box(10, 10, 80, 40)),
    ]);
    expect(sketch.regions.map((region) => [region.id, region.bounds.x, region.bounds.y])).toEqual([
      ["r1", 10, 10],
      ["r2", 300, 10],
      ["r3", 10, 200],
    ]);
  });

  it("ignores ink a compile already archived", () => {
    const sketch = readSketch([
      ink("box", box(0, 0, 100, 60)),
      { ...ink("old", box(400, 400, 100, 60)), archived: true },
    ]);
    expect(sketch.regions).toHaveLength(1);
    expect(sketch.loose).toEqual([]);
  });

  it("nests a box inside a box", () => {
    const sketch = readSketch([ink("outer", box(0, 0, 300, 200)), ink("inner", box(50, 50, 100, 60))]);
    const outer = sketch.regions.find((region) => region.id === "r1")!;
    const inner = sketch.regions.find((region) => region.id === "r2")!;
    expect(outer.contains).toEqual(["r2"]);
    expect(inner.parent).toBe("r1");
  });

  it("does not let two identical boxes contain each other", () => {
    const same = box(0, 0, 100, 60);
    const sketch = readSketch([ink("a", same), ink("b", same)]);
    expect(sketch.regions.map((region) => region.parent)).toEqual([null, null]);
  });

  it("connects the boxes an open stroke runs between", () => {
    const sketch = readSketch([
      ink("a", box(0, 0, 100, 60)),
      ink("b", box(200, 0, 100, 60)),
      ink("arrow", "M60 30 L240 30"),
    ]);
    expect(sketch.connectors).toEqual([{ id: "c1", from: "r1", to: "r2" }]);
    expect(sketch.loose).toEqual([]);
  });

  it("does not read writing inside a shape as a link", () => {
    // Letters are open strokes that start and end inside the same shape.
    const sketch = readSketch([
      ink("box", box(0, 0, 200, 120)),
      ink("letter1", "M40 40 L40 80"),
      ink("letter2", "M40 60 L60 60"),
      ink("letter3", "M60 40 L60 80"),
    ]);
    expect(sketch.regions).toHaveLength(1);
    expect(sketch.connectors).toEqual([]);
    expect(sketch.loose.map((element) => element.id)).toEqual(["letter1", "letter2", "letter3"]);
  });

  it("keeps a connector whose far end lands in empty space", () => {
    const sketch = readSketch([ink("a", box(0, 0, 100, 60)), ink("arrow", "M60 30 L400 30")]);
    expect(sketch.connectors).toEqual([{ id: "c1", from: "r1", to: null }]);
  });

  it("treats a mark too short to connect anything as loose ink", () => {
    const sketch = readSketch([ink("a", box(0, 0, 100, 60)), ink("tick", "M60 30 L66 30")]);
    expect(sketch.connectors).toEqual([]);
    expect(sketch.loose.map((element) => element.id)).toEqual(["tick"]);
  });

  it("keeps strokes it cannot read as ink rather than guessing", () => {
    const sketch = readSketch([ink("arc", "M0 0 A10 10 0 0 1 20 20"), ink("box", box(0, 0, 80, 40))]);
    expect(sketch.regions).toHaveLength(1);
    expect(sketch.loose.map((element) => element.id)).toEqual(["arc"]);
  });

  it("keeps a shape with no fill ratio as ink", () => {
    const sketch = readSketch([ink("scribble", `${diamond}`)]);
    expect(sketch.regions).toEqual([]);
    expect(sketch.loose.map((element) => element.id)).toEqual(["scribble"]);
  });

  it("ignores a loop too small to be a region", () => {
    const sketch = readSketch([ink("dot", box(0, 0, 6, 6))]);
    expect(sketch.regions).toEqual([]);
    expect(sketch.loose).toHaveLength(1);
  });
});
