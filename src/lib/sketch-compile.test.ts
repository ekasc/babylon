import { describe, expect, it } from "vitest";
import type { CanvasInk, Scene } from "./canvas-dsl";
import { compileSketch, readRegions, type RegionClassifier, type RegionReading } from "./sketch-compile";
import { readSketch } from "./sketch-geometry";

const box = (x: number, y: number, width: number, height: number): string =>
  `M${x} ${y} L${x + width} ${y} L${x + width} ${y + height} L${x} ${y + height} Z`;

const ink = (id: string, d: string): CanvasInk => ({ id, d });

const reading = (role: RegionReading["role"], label: string, confidence = 0.9): RegionReading => ({
  role,
  label,
  confidence,
});

function compile(drawings: CanvasInk[], answers: Record<string, RegionReading>, existing?: Scene) {
  const sketch = readSketch(drawings);
  return compileSketch(sketch, new Map(Object.entries(answers)), existing);
}

const sceneWith = (nodes: Scene["nodes"], edges: Scene["edges"] = []): Scene => ({ nodes, edges, ink: [] });

describe("compiling a sketch", () => {
  it("turns a drawn box into a node of the role it was read as", () => {
    const result = compile([ink("a", box(10, 10, 120, 60))], { r1: reading("decision", "Paid?") });
    expect(result.scene.nodes).toEqual([
      { id: "paid", kind: "decision", label: "Paid?", at: { x: 24, y: 24 } },
    ]);
    expect(result.unsure).toEqual([]);
  });

  it("re-anchors sketching coordinates but keeps the arrangement", () => {
    const result = compile([ink("a", box(500, 300, 120, 60)), ink("b", box(700, 300, 120, 60))], {
      r1: reading("process", "One"),
      r2: reading("process", "Two"),
    });
    expect(result.scene.nodes.map((node) => node.at)).toEqual([
      { x: 24, y: 24 },
      { x: 224, y: 24 },
    ]);
  });

  it("names nodes from their labels and keeps collisions apart", () => {
    const result = compile([ink("a", box(10, 10, 100, 50)), ink("b", box(10, 200, 100, 50))], {
      r1: reading("process", "Cart"),
      r2: reading("process", "Cart"),
    });
    expect(result.scene.nodes.map((node) => node.id)).toEqual(["cart", "cart-2"]);
  });

  it("draws an unconfident shape but refuses to name its role", () => {
    const result = compile([ink("a", box(10, 10, 120, 60))], { r1: reading("decision", "Maybe", 0.2) });
    expect(result.scene.nodes[0]).toMatchObject({ id: "maybe", kind: "process", label: "Maybe" });
    expect(result.unsure).toEqual([{ id: "r1", label: "Maybe", reason: "the role decision was not confident enough" }]);
  });

  it("treats an explicit unknown as a question", () => {
    const result = compile([ink("a", box(10, 10, 120, 60))], { r1: reading("unknown", "Thing", 0.99) });
    expect(result.scene.nodes[0]?.kind).toBe("process");
    expect(result.unsure).toHaveLength(1);
  });

  it("reports a region that produced no reading at all", () => {
    const result = compile([ink("a", box(10, 10, 120, 60))], {});
    expect(result.scene.nodes[0]?.kind).toBe("process");
    expect(result.unsure[0]?.reason).toBe("no reading was produced for this shape");
  });

  it("makes a box that holds other boxes a group, whatever it was read as", () => {
    const result = compile(
      [ink("outer", box(0, 0, 300, 200)), ink("inner", box(50, 50, 100, 60))],
      { r1: reading("note", "Card"), r2: reading("process", "Save") }
    );
    expect(result.scene.nodes).toMatchObject([
      { id: "card", kind: "group", at: { x: 24, y: 24 } },
      { id: "save", kind: "process", in: "card" },
    ]);
    expect(result.unsure).toEqual([
      { id: "r1", label: "Card", reason: "read as note, but other shapes are drawn inside it, so it compiles to a group" },
    ]);
  });

  it("turns a line between two shapes into an edge", () => {
    const result = compile(
      [ink("a", box(0, 0, 100, 60)), ink("b", box(200, 0, 100, 60)), ink("line", "M60 30 L240 30")],
      { r1: reading("process", "Cart"), r2: reading("process", "Paid") }
    );
    expect(result.scene.edges).toEqual([{ from: "cart", to: "paid" }]);
  });

  it("asks about a line that does not land on a shape", () => {
    const result = compile([ink("a", box(0, 0, 100, 60)), ink("line", "M60 30 L400 30")], {
      r1: reading("process", "Cart"),
    });
    expect(result.scene.edges).toEqual([]);
    expect(result.unsure).toEqual([{ id: "c1", label: "", reason: "one end of this line does not land on a shape" }]);
  });

  it("carries ink it could not compile into the scene", () => {
    const result = compile([ink("a", box(0, 0, 100, 60)), ink("arc", "M0 0 A10 10 0 0 1 20 20")], {
      r1: reading("process", "Cart"),
    });
    expect(result.scene.ink.map((element) => element.id)).toEqual(["arc"]);
  });
});

describe("compiling against an existing scene", () => {
  const existing = sceneWith([
    { id: "cart", kind: "process", label: "Cart" },
    { id: "legacy", kind: "note", label: "Old" },
  ]);

  it("joins by label and reuses the id instead of renaming the node", () => {
    const result = compile([ink("a", box(10, 10, 120, 60))], { r1: reading("process", "Cart") }, existing);
    expect(result.scene.nodes[0]?.id).toBe("cart");
    // Nothing was added, retyped or relabelled; the node the sketch left out is reported.
    expect(result.changes).toEqual([{ kind: "node-removed", id: "legacy", label: "Old" }]);
  });

  it("reports a role change on a node it matched", () => {
    const result = compile([ink("a", box(10, 10, 120, 60))], { r1: reading("data", "Cart") }, existing);
    expect(result.changes).toContainEqual({ kind: "node-retyped", id: "cart", from: "process", to: "data" });
  });

  it("reports an added node and edge for a fresh sketch", () => {
    const result = compile([ink("a", box(10, 10, 120, 60))], { r1: reading("process", "Cart") });
    expect(result.changes).toEqual([{ kind: "node-added", id: "cart", label: "Cart", nodeKind: "process" }]);
  });

  it("reports an edge the sketch no longer draws", () => {
    const result = compile(
      [ink("a", box(10, 10, 120, 60))],
      { r1: reading("process", "Cart") },
      sceneWith([{ id: "cart", kind: "process", label: "Cart" }], [{ from: "cart", to: "gone" }])
    );
    expect(result.changes).toContainEqual({ kind: "edge-removed", from: "cart", to: "gone" });
  });

  it("claims a matched node only once", () => {
    const result = compile(
      [ink("a", box(10, 10, 100, 50)), ink("b", box(10, 200, 100, 50))],
      { r1: reading("process", "Cart"), r2: reading("process", "Cart") },
      existing
    );
    expect(result.scene.nodes.map((node) => node.id)).toEqual(["cart", "cart-2"]);
  });

  it("gives the same answer twice", () => {
    const drawings = [ink("a", box(0, 0, 100, 60)), ink("b", box(200, 0, 100, 60)), ink("line", "M60 30 L240 30")];
    const answers = { r1: reading("process", "Cart"), r2: reading("decision", "Paid") };
    expect(compile(drawings, answers, existing)).toEqual(compile(drawings, answers, existing));
  });
});

describe("classifying regions", () => {
  it("collects a reading per region", async () => {
    const sketch = readSketch([ink("a", box(0, 0, 100, 60)), ink("b", box(200, 0, 100, 60))]);
    const classify: RegionClassifier = async (region) => reading("process", `Shape ${region.id}`);
    const readings = await readRegions(sketch.regions, classify);
    expect([...readings.keys()]).toEqual(["r1", "r2"]);
    expect(readings.get("r2")?.label).toBe("Shape r2");
  });

  it("turns a failing classifier into a question rather than a failed compile", async () => {
    const sketch = readSketch([ink("a", box(0, 0, 100, 60)), ink("b", box(200, 0, 100, 60))]);
    const classify: RegionClassifier = async (region) => {
      if (region.id === "r1") throw new Error("vision unavailable");
      return reading("process", "Fine");
    };
    const readings = await readRegions(sketch.regions, classify);
    const result = compileSketch(sketch, readings);
    expect(result.scene.nodes.map((node) => node.label)).toEqual(["r1", "Fine"]);
    expect(result.unsure).toEqual([{ id: "r1", label: "", reason: "no reading was produced for this shape" }]);
  });
});
