// @vitest-environment jsdom
// Mermaid must enter the module graph through a static import. Its own dynamic
// import of the DOMPurify transitive dependency is externalized otherwise, and
// under Node that copy of DOMPurify is a no-op stub with no sanitize, so any
// flowchart with a label fails to parse. Loading Mermaid here first means the
// dynamic import inside the importer resolves to this same instance.
import "mermaid";
import { describe, expect, it } from "vitest";
import { parseCanvas, serializeCanvas } from "./canvas-dsl";
import {
  type MermaidGraph,
  canvasIdMap,
  kindForShape,
  plainLabel,
  sceneFromMermaid,
} from "./mermaid-import";

function graph(partial: Partial<MermaidGraph> = {}): MermaidGraph {
  return { vertices: [], edges: [], subGraphs: [], ...partial };
}

describe("mermaid import", () => {
  describe("shape to kind", () => {
    it("maps the shapes that carry meaning", () => {
      expect(kindForShape("diamond")).toBe("decision");
      expect(kindForShape("question")).toBe("decision");
      expect(kindForShape("stadium")).toBe("terminator");
      expect(kindForShape("doublecircle")).toBe("terminator");
      expect(kindForShape("cylinder")).toBe("data");
    });

    it("treats every box shape as a process", () => {
      for (const shape of ["square", "rect", "round", "subroutine", "hexagon", "odd", "circle", "ellipse", "trapezoid", "inv_trapezoid", "lean_right", "lean_left", "squareRect", undefined]) {
        expect(kindForShape(shape)).toBe("process");
      }
    });
  });

  describe("labels", () => {
    it("strips markup and keeps the words", () => {
      expect(plainLabel("<b>Bold</b> text")).toBe("Bold text");
      expect(plainLabel("first<br/>second")).toBe("first second");
      expect(plainLabel("a<br> b")).toBe("a b");
      expect(plainLabel("fits &amp; starts")).toBe("fits & starts");
      expect(plainLabel("5 &lt; 6")).toBe("5 < 6");
      expect(plainLabel("  spaced   out  ")).toBe("spaced out");
    });

    it("decodes escaped entities in the right order", () => {
      expect(plainLabel("&amp;lt;")).toBe("&lt;");
    });

    it("falls back to the id when there is no text", () => {
      const scene = sceneFromMermaid(graph({ vertices: [{ id: "a" }] }));
      expect(scene.nodes[0]?.label).toBe("a");
    });
  });

  describe("ids", () => {
    it("sanitises ids the DSL cannot hold", () => {
      const ids = canvasIdMap(graph({ vertices: [{ id: "a b" }, { id: "c/d" }, { id: "e:f" }] }));
      expect([...ids.values()]).toEqual(["a_b", "c_d", "e_f"]);
    });

    it("prefixes ids that would not start a canvas id", () => {
      const ids = canvasIdMap(graph({ vertices: [{ id: "1" }, { id: "2n" }] }));
      expect([...ids.values()]).toEqual(["n_1", "n_2n"]);
    });

    it("keeps colliding ids distinct and stable", () => {
      const ids = canvasIdMap(graph({ vertices: [{ id: "a b" }, { id: "a_b" }, { id: "a-b" }] }));
      expect([...ids.values()]).toEqual(["a_b", "a_b_2", "a-b"]);
    });

    it("gives a subgraph and a vertex of the same name one id", () => {
      const ids = canvasIdMap(graph({ vertices: [{ id: "S" }], subGraphs: [{ id: "S", nodes: [] }] }));
      expect([...ids.values()]).toEqual(["S"]);
    });
  });

  describe("containment", () => {
    it("turns a subgraph into a group and puts members inside it", () => {
      const scene = sceneFromMermaid(
        graph({
          vertices: [{ id: "a" }, { id: "b" }],
          subGraphs: [{ id: "s", title: "Flow", nodes: ["a", "b"] }],
        })
      );
      expect(scene.nodes).toEqual([
        { id: "s", kind: "group", label: "Flow" },
        { id: "a", kind: "process", label: "a", in: "s" },
        { id: "b", kind: "process", label: "b", in: "s" },
      ]);
    });

    it("does not emit a node for the subgraph's own vertex entry", () => {
      const scene = sceneFromMermaid(
        graph({ vertices: [{ id: "s", text: "s" }], subGraphs: [{ id: "s", title: "Flow", nodes: [] }] })
      );
      expect(scene.nodes).toHaveLength(1);
      expect(scene.nodes[0]).toMatchObject({ id: "s", kind: "group", label: "Flow" });
    });

    it("nests a subgraph inside another", () => {
      const scene = sceneFromMermaid(
        graph({
          vertices: [{ id: "a" }],
          subGraphs: [
            { id: "inner", title: "Inner", nodes: ["a"] },
            { id: "outer", title: "Outer", nodes: ["inner"] },
          ],
        })
      );
      expect(scene.nodes.find((node) => node.id === "inner")).toMatchObject({ in: "outer" });
      expect(scene.nodes.find((node) => node.id === "a")).toMatchObject({ in: "inner" });
    });

    it("lets the last subgraph listing a node win", () => {
      const scene = sceneFromMermaid(
        graph({
          vertices: [{ id: "a" }],
          subGraphs: [
            { id: "one", title: "One", nodes: ["a"] },
            { id: "two", title: "Two", nodes: ["a"] },
          ],
        })
      );
      expect(scene.nodes.find((node) => node.id === "a")).toMatchObject({ in: "two" });
    });
  });

  describe("edges", () => {
    it("carries a label and drops an empty one", () => {
      const scene = sceneFromMermaid(
        graph({
          vertices: [{ id: "a" }, { id: "b" }, { id: "c" }],
          edges: [
            { start: "a", end: "b", text: "yes" },
            { start: "b", end: "c", text: "" },
          ],
        })
      );
      expect(scene.edges).toEqual([
        { from: "a", to: "b", label: "yes" },
        { from: "b", to: "c" },
      ]);
    });

    it("maps dotted to dashed and folds thick onto solid", () => {
      const scene = sceneFromMermaid(
        graph({
          vertices: [{ id: "a" }, { id: "b" }, { id: "c" }],
          edges: [
            { start: "a", end: "b", stroke: "dotted" },
            { start: "b", end: "c", stroke: "thick" },
          ],
        })
      );
      expect(scene.edges[0]?.dashed).toBe(true);
      expect(scene.edges[1]?.dashed).toBeUndefined();
    });

    it("drops an edge whose endpoint has no node", () => {
      const scene = sceneFromMermaid(
        graph({ vertices: [{ id: "a" }], edges: [{ start: "a", end: "ghost" }] })
      );
      expect(scene.edges).toEqual([]);
    });
  });

  describe("direction", () => {
    it("keeps left to right and folds the rest to top to bottom", () => {
      expect(sceneFromMermaid(graph({ direction: "LR" })).direction).toBe("LR");
      expect(sceneFromMermaid(graph({ direction: "TB" })).direction).toBe("TB");
      expect(sceneFromMermaid(graph({ direction: "TD" })).direction).toBe("TB");
      expect(sceneFromMermaid(graph({ direction: "RL" })).direction).toBe("TB");
      expect(sceneFromMermaid(graph({ direction: "BT" })).direction).toBe("TB");
      expect(sceneFromMermaid(graph({})).direction).toBe("TB");
    });
  });

  it("emits a scene the DSL accepts", () => {
    const scene = sceneFromMermaid(
      graph({
        vertices: [{ id: "a", text: "Cart", type: "square" }, { id: "b", text: "Paid?", type: "diamond" }],
        edges: [{ start: "a", end: "b", text: "submit" }],
        subGraphs: [{ id: "s", title: "Flow", nodes: ["a"] }],
        direction: "LR",
      })
    );
    const parsed = parseCanvas(serializeCanvas(scene));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.scene).toEqual(scene);
  });
});

describe("mermaid import from real source", () => {
  const source = `flowchart LR
  A[Cart] --> B{Paid?}
  B -->|yes| C([Done])
  B -.-> D[(Store)]
  subgraph S[Flow]
    A
    B
  end
  subgraph T[Outer]
    S
  end
`;

  it("reads a flowchart through mermaid's own parser", async () => {
    const { sceneFromMermaidText } = await import("./mermaid-import");
    const scene = await sceneFromMermaidText(source);

    expect(scene.direction).toBe("LR");
    expect(scene.nodes.map((node) => [node.id, node.kind, node.label, node.in])).toEqual([
      ["S", "group", "Flow", "T"],
      ["T", "group", "Outer", undefined],
      ["A", "process", "Cart", "S"],
      ["B", "decision", "Paid?", "S"],
      ["C", "terminator", "Done", undefined],
      ["D", "data", "Store", undefined],
    ]);
    expect(scene.edges).toEqual([
      { from: "A", to: "B" },
      { from: "B", to: "C", label: "yes" },
      { from: "B", to: "D", dashed: true },
    ]);
  });

  it("round trips the imported scene through the DSL", async () => {
    const { sceneFromMermaidText } = await import("./mermaid-import");
    const scene = await sceneFromMermaidText(source);
    const text = serializeCanvas(scene);
    const parsed = parseCanvas(text);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.scene).toEqual(scene);
    expect(text).toContain("direction LR");
    expect(text).toContain('node A process "Cart" in S');
  });

  it("refuses diagram types the canvas cannot draw", async () => {
    const { sceneFromMermaidText } = await import("./mermaid-import");
    await expect(sceneFromMermaidText("sequenceDiagram\n  A->>B: hi\n")).rejects.toThrow(
      "Only Mermaid flowcharts can be opened on the canvas."
    );
  });
});
