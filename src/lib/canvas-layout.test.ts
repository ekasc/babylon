import { describe, expect, it } from "vitest";
import type { Scene } from "./canvas-dsl";
import { boxWidth, layoutScene, rankNodes, type SceneLayout } from "./canvas-layout";

function scene(nodes: Scene["nodes"], edges: Scene["edges"] = [], direction?: Scene["direction"]): Scene {
  return { nodes, edges, ink: [], ...(direction ? { direction } : {}) };
}

const box = (layout: SceneLayout, id: string) => {
  const found = layout.boxes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing box ${id}`);
  return found;
};

const firstEdge = (layout: SceneLayout) => {
  const edge = layout.edges[0];
  if (!edge) throw new Error("missing edge");
  return edge;
};

const pointAt = (points: Array<{ x: number; y: number }>, index: number): { x: number; y: number } => {
  const point = points[index];
  if (!point) throw new Error(`missing point ${index}`);
  return point;
};

const firstPoint = (edge: { points: Array<{ x: number; y: number }> }) => pointAt(edge.points, 0);

describe("ranks", () => {
  it("ranks a chain by distance from its entry", () => {
    const ranks = rankNodes(["a", "b", "c"], new Map([["b", ["a"]], ["c", ["b"]]]));
    expect([ranks.get("a"), ranks.get("b"), ranks.get("c")]).toEqual([0, 1, 2]);
  });

  it("ranks both sides of a diamond one step past their shared parent", () => {
    const ranks = rankNodes(
      ["a", "b", "c", "d"],
      new Map([["b", ["a"]], ["c", ["a"]], ["d", ["b", "c"]]])
    );
    expect([ranks.get("a"), ranks.get("b"), ranks.get("c"), ranks.get("d")]).toEqual([0, 1, 1, 2]);
  });

  it("takes the longest path, not the first one found", () => {
    const ranks = rankNodes(["a", "b", "c"], new Map([["b", ["a"]], ["c", ["a", "b"]]]));
    expect(ranks.get("c")).toBe(2);
  });

  it("terminates on a cycle", () => {
    const ranks = rankNodes(["a", "b"], new Map([["a", ["b"]], ["b", ["a"]]]));
    expect(ranks.get("a")).toBeTypeOf("number");
    expect(ranks.get("b")).toBeTypeOf("number");
  });
});

describe("layout", () => {
  it("stacks ranks downward by default", () => {
    const layout = layoutScene(
      scene([{ id: "a", kind: "process", label: "A" }, { id: "b", kind: "process", label: "B" }], [{ from: "a", to: "b" }])
    );
    expect(box(layout, "b").y).toBeGreaterThan(box(layout, "a").y);
    expect(box(layout, "b").x).toBe(box(layout, "a").x);
  });

  it("advances ranks rightward when the scene is left to right", () => {
    const layout = layoutScene(
      scene([{ id: "a", kind: "process", label: "A" }, { id: "b", kind: "process", label: "B" }], [{ from: "a", to: "b" }], "LR")
    );
    expect(box(layout, "b").x).toBeGreaterThan(box(layout, "a").x);
    expect(box(layout, "b").y).toBe(box(layout, "a").y);
  });

  it("lays unconnected nodes out side by side in the same rank", () => {
    const layout = layoutScene(
      scene([{ id: "a", kind: "process", label: "A" }, { id: "b", kind: "process", label: "B" }])
    );
    expect(box(layout, "a").y).toBe(box(layout, "b").y);
    expect(box(layout, "a").x).not.toBe(box(layout, "b").x);
    expect(box(layout, "a").rank).toBe(0);
  });

  it("ignores a self edge when ranking", () => {
    const layout = layoutScene(
      scene([{ id: "a", kind: "process", label: "A" }], [{ from: "a", to: "a" }])
    );
    expect(box(layout, "a").rank).toBe(0);
  });

  it("lets an explicit position override the computed one", () => {
    const layout = layoutScene(
      scene([{ id: "a", kind: "process", label: "A", at: { x: 400, y: 12 } }])
    );
    expect(box(layout, "a")).toMatchObject({ x: 400, y: 12 });
  });

  it("keeps the computed width when only a position is given", () => {
    const layout = layoutScene(
      scene([{ id: "a", kind: "process", label: "A label", at: { x: 400, y: 12 } }])
    );
    expect(box(layout, "a").width).toBe(boxWidth("A label"));
  });

  it("sizes a box to its label, within limits", () => {
    expect(boxWidth("A")).toBe(boxWidth("AB"));
    expect(boxWidth("a very long label that keeps going and going")).toBeLessThanOrEqual(264);
    expect(boxWidth("a very long label that keeps going and going")).toBeGreaterThan(boxWidth("short"));
    expect(boxWidth("")).toBeGreaterThanOrEqual(104);
  });

  it("survives an empty scene without producing NaN", () => {
    const layout = layoutScene(scene([]));
    expect(layout.boxes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(Number.isFinite(layout.width)).toBe(true);
    expect(Number.isFinite(layout.height)).toBe(true);
  });

  it("frames only what is drawn, so an archived sketch leaves no dead space", () => {
    const node = { id: "a", kind: "process" as const, label: "A" };
    const live = layoutScene({ nodes: [node], edges: [], ink: [{ id: "s", d: "M0 0 L2000 0 L2000 2000 L0 2000 Z" }] });
    const archived = layoutScene({
      nodes: [node],
      edges: [],
      ink: [{ id: "s", d: "M0 0 L2000 0 L2000 2000 L0 2000 Z", archived: true }],
    });
    expect(live.width).toBeGreaterThan(2000);
    expect(archived.width).toBeLessThan(1000);
  });

  it("produces the same geometry for two equal scenes", () => {
    const build = () =>
      layoutScene(scene([{ id: "a", kind: "process", label: "A" }, { id: "b", kind: "decision", label: "B?" }], [{ from: "a", to: "b", label: "go" }]));
    expect(build()).toEqual(build());
  });
});

describe("groups", () => {
  const grouped = scene([
    { id: "s", kind: "group", label: "Flow" },
    { id: "a", kind: "process", label: "A", in: "s" },
    { id: "b", kind: "process", label: "B", in: "s" },
  ]);

  it("draws a group around its members with room for a title", () => {
    const layout = layoutScene(grouped);
    const group = box(layout, "s");
    for (const id of ["a", "b"]) {
      const member = box(layout, id);
      expect(group.x).toBeLessThan(member.x);
      expect(group.y).toBeLessThan(member.y);
      expect(group.x + group.width).toBeGreaterThan(member.x + member.width);
      expect(group.y + group.height).toBeGreaterThan(member.y + member.height);
    }
  });

  it("contains a nested group's members too", () => {
    const layout = layoutScene(
      scene([
        { id: "outer", kind: "group", label: "Outer" },
        { id: "inner", kind: "group", label: "Inner", in: "outer" },
        { id: "a", kind: "process", label: "A", in: "inner" },
        { id: "b", kind: "process", label: "B", in: "outer" },
      ])
    );
    const outer = box(layout, "outer");
    const inner = box(layout, "inner");
    const a = box(layout, "a");
    const b = box(layout, "b");
    // Containment is per side, so the shared left edge is expected to coincide.
    // Outer covers its own member and everything the inner group holds.
    expect(outer.x).toBeLessThanOrEqual(inner.x);
    expect(outer.y).toBeLessThanOrEqual(inner.y);
    expect(outer.x + outer.width).toBeGreaterThan(inner.x + inner.width);
    expect(outer.y + outer.height).toBeGreaterThanOrEqual(inner.y + inner.height);
    expect(outer.width * outer.height).toBeGreaterThan(inner.width * inner.height);
    expect(outer.x).toBeLessThanOrEqual(b.x);
    expect(outer.x + outer.width).toBeGreaterThanOrEqual(b.x + b.width);
    expect(inner.x).toBeLessThan(a.x);
    expect(inner.x + inner.width).toBeGreaterThan(a.x + a.width);
  });

  it("gives an empty group a box of its own", () => {
    const layout = layoutScene(scene([{ id: "s", kind: "group", label: "Empty" }]));
    expect(box(layout, "s").width).toBeGreaterThan(0);
    expect(box(layout, "s").height).toBeGreaterThan(0);
  });

  it("reshapes a group when a member moves", () => {
    const before = layoutScene(grouped);
    const after = layoutScene(
      scene([
        { id: "s", kind: "group", label: "Flow" },
        { id: "a", kind: "process", label: "A", in: "s" },
        { id: "b", kind: "process", label: "B", in: "s", at: { x: 900, y: 500 } },
      ])
    );
    expect(box(after, "s").width).toBeGreaterThan(box(before, "s").width);
  });
});

describe("edges", () => {
  it("runs edge endpoints along the box borders, not through the middle", () => {
    const layout = layoutScene(
      scene([{ id: "a", kind: "process", label: "A" }, { id: "b", kind: "process", label: "B" }], [{ from: "a", to: "b" }])
    );
    const a = box(layout, "a");
    const b = box(layout, "b");
    const edge = firstEdge(layout);
    expect(pointAt(edge.points, 0).y).toBeCloseTo(a.y + a.height);
    expect(pointAt(edge.points, 0).x).toBeCloseTo(a.x + a.width / 2);
    expect(pointAt(edge.points, 1).y).toBeCloseTo(b.y);
  });

  it("runs a left to right edge between the facing sides", () => {
    const layout = layoutScene(
      scene([{ id: "a", kind: "process", label: "A" }, { id: "b", kind: "process", label: "B" }], [{ from: "a", to: "b" }], "LR")
    );
    const a = box(layout, "a");
    const b = box(layout, "b");
    expect(pointAt(firstEdge(layout).points, 0).x).toBeCloseTo(a.x + a.width);
    expect(pointAt(firstEdge(layout).points, 1).x).toBeCloseTo(b.x);
  });

  it("routes a self edge out of the right side and back into the top", () => {
    const layout = layoutScene(scene([{ id: "a", kind: "process", label: "A" }], [{ from: "a", to: "a" }]));
    const a = box(layout, "a");
    const points = firstEdge(layout).points;
    expect(points.length).toBeGreaterThan(2);
    expect(pointAt(points, 0).x).toBeCloseTo(a.x + a.width);
    expect(pointAt(points, points.length - 1).y).toBeCloseTo(a.y);
  });

  it("places an edge label between the endpoints", () => {
    const layout = layoutScene(
      scene([{ id: "a", kind: "process", label: "A" }, { id: "b", kind: "process", label: "B" }], [{ from: "a", to: "b", label: "go" }])
    );
    const edge = firstEdge(layout);
    expect(edge.label).toBe("go");
    expect(edge.labelAt.y).toBeGreaterThan(pointAt(edge.points, 0).y);
    expect(edge.labelAt.y).toBeLessThan(pointAt(edge.points, 1).y);
  });

  it("hangs an edge off a group's border", () => {
    const layout = layoutScene(
      scene([
        { id: "s", kind: "group", label: "Flow" },
        { id: "a", kind: "process", label: "A", in: "s" },
        { id: "b", kind: "process", label: "B" },
      ], [{ from: "s", to: "b" }])
    );
    const group = box(layout, "s");
    const start = pointAt(firstEdge(layout).points, 0);
    const onBorder =
      Math.min(Math.abs(start.x - group.x), Math.abs(start.x - (group.x + group.width)), Math.abs(start.y - group.y), Math.abs(start.y - (group.y + group.height))) < 0.005;
    expect(onBorder).toBe(true);
  });
});

describe("bounds", () => {
  it("encloses every box it produced", () => {
    const layout = layoutScene(
      scene([
        { id: "s", kind: "group", label: "Flow" },
        { id: "a", kind: "process", label: "A", in: "s" },
        { id: "b", kind: "decision", label: "A much longer label here" },
        { id: "c", kind: "terminator", label: "C" },
      ], [{ from: "a", to: "b" }, { from: "b", to: "c" }], "LR")
    );
    for (const candidate of layout.boxes) {
      expect(candidate.x).toBeGreaterThanOrEqual(layout.x);
      expect(candidate.y).toBeGreaterThanOrEqual(layout.y);
      expect(candidate.x + candidate.width).toBeLessThanOrEqual(layout.x + layout.width);
      expect(candidate.y + candidate.height).toBeLessThanOrEqual(layout.y + layout.height);
    }
  });

  it("grows to take in a dragged node", () => {
    const near = layoutScene(scene([{ id: "a", kind: "process", label: "A" }, { id: "b", kind: "process", label: "B" }]));
    const far = layoutScene(
      scene([{ id: "a", kind: "process", label: "A" }, { id: "b", kind: "process", label: "B", at: { x: 2000, y: 1500 } }])
    );
    expect(far.width).toBeGreaterThan(near.width);
    expect(far.height).toBeGreaterThan(near.height);
  });

  it("reports the origin so a scene dragged from the origin stays in view", () => {
    const layout = layoutScene(scene([{ id: "a", kind: "process", label: "A", at: { x: 2000, y: 1500 } }]));
    const a = box(layout, "a");
    expect(layout.x).toBeLessThan(a.x);
    expect(layout.y).toBeLessThan(a.y);
    expect(layout.x + layout.width).toBeGreaterThan(a.x + a.width);
    expect(layout.y + layout.height).toBeGreaterThan(a.y + a.height);
  });
});
