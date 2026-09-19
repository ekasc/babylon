import { describe, expect, it } from "vitest";
import {
  CANVAS_DSL_VERSION,
  type CanvasParseError,
  type Scene,
  parseCanvas,
  serializeCanvas,
} from "./canvas-dsl";

const CANONICAL = `canvas 1

node flow group "Checkout flow" at 40,20
node cart process "Cart" in flow
node paid decision "Payment ok?" in flow

edge cart -> paid "submit"
edge paid -> cart "retry" dashed

ink mark1 "M4 8 L40 12 L60 4" stroke #ff3b30 width 2
`;

function mustParse(text: string): Scene {
  const result = parseCanvas(text);
  if (!result.ok) throw new Error(`expected a parse, got ${JSON.stringify(result.errors)}`);
  return result.scene;
}

function errorsOf(text: string): CanvasParseError[] {
  const result = parseCanvas(text);
  if (result.ok) throw new Error("expected a parse error");
  return result.errors;
}

describe("canvas dsl", () => {
  it("parses every field a scene can hold", () => {
    expect(mustParse(CANONICAL)).toEqual({
      nodes: [
        { id: "flow", kind: "group", label: "Checkout flow", at: { x: 40, y: 20 } },
        { id: "cart", kind: "process", label: "Cart", in: "flow" },
        { id: "paid", kind: "decision", label: "Payment ok?", in: "flow" },
      ],
      edges: [
        { from: "cart", to: "paid", label: "submit" },
        { from: "paid", to: "cart", label: "retry", dashed: true },
      ],
      ink: [{ id: "mark1", d: "M4 8 L40 12 L60 4", stroke: "#ff3b30", width: 2 }],
    });
  });

  it("is a fixed point, so a human edit cannot drift the file", () => {
    const scene = mustParse(CANONICAL);
    expect(serializeCanvas(scene)).toBe(CANONICAL);
  });

  it("survives a round trip through the wire form", () => {
    const scene = mustParse(CANONICAL);
    expect(mustParse(serializeCanvas(scene))).toEqual(scene);
  });

  it("keeps a node move to a one line diff", () => {
    const scene = mustParse(CANONICAL);
    const before = serializeCanvas(scene).split("\n");
    const after = serializeCanvas({
      ...scene,
      nodes: scene.nodes.map((node) => (node.id === "cart" ? { ...node, at: { x: 200, y: 80 } } : node)),
    }).split("\n");

    expect(after.filter((line, i) => line !== before[i])).toEqual(["node cart process \"Cart\" at 200,80 in flow"]);
  });

  it("keeps a label edit local and loses nothing else", () => {
    const scene = mustParse(CANONICAL);
    const edited = {
      ...scene,
      nodes: scene.nodes.map((node) => (node.id === "paid" ? { ...node, label: "Paid?" } : node)),
    };
    const reparsed = mustParse(serializeCanvas(edited));

    expect(reparsed.nodes[2].label).toBe("Paid?");
    expect(reparsed.nodes[0]).toEqual(scene.nodes[0]);
    expect(reparsed.edges).toEqual(scene.edges);
    expect(reparsed.ink).toEqual(scene.ink);
  });

  it("round trips labels that need escaping", () => {
    const label = 'say "hi" \\ and\nwrap';
    const text = serializeCanvas({
      nodes: [{ id: "a", kind: "note", label }],
      edges: [],
      ink: [],
    });

    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    expect(mustParse(text).nodes[0].label).toBe(label);
  });

  it("tolerates blank lines and indentation", () => {
    const text = `canvas 1\n\n\n  node a process "A"\n\n   node b group "B"\n  node c process "C" in b\n`;
    expect(mustParse(text).nodes).toHaveLength(3);
  });

  it("accepts an empty scene", () => {
    expect(mustParse(`canvas ${CANVAS_DSL_VERSION}\n`)).toEqual({ nodes: [], edges: [], ink: [] });
  });

  describe("rejects malformed input with a line number", () => {
    it("missing header", () => {
      expect(errorsOf(`node a process "A"\n`)).toEqual([
        { line: 1, message: 'expected "canvas 1" on the first line' },
      ]);
    });

    it("unknown version", () => {
      expect(errorsOf("canvas 99\n")[0]).toMatchObject({ line: 1 });
      expect(errorsOf("canvas 99\n")[0].message).toContain("unsupported canvas version 99");
    });

    it("empty file", () => {
      expect(errorsOf("")).toHaveLength(1);
    });

    it("unknown node kind, naming the valid ones", () => {
      const [error] = errorsOf(`canvas 1\nnode a widget "A"\n`);
      expect(error.line).toBe(2);
      expect(error.message).toContain("unknown node kind");
      expect(error.message).toContain("decision");
    });

    it("unquoted label, which would otherwise swallow the next keyword", () => {
      expect(errorsOf(`canvas 1\nnode a process at 1,2\n`)[0]).toMatchObject({
        line: 2,
        message: 'node label must be quoted, got "at"',
      });
    });

    it("unterminated quote", () => {
      expect(errorsOf(`canvas 1\nnode a process "A\n`)[0]).toMatchObject({
        line: 2,
        message: "unterminated quoted value",
      });
    });

    it("duplicate node id", () => {
      expect(errorsOf(`canvas 1\nnode a process "A"\nnode a process "B"\n`)[0]).toMatchObject({
        line: 3,
        message: 'duplicate node id "a"',
      });
    });

    it("duplicate ink id", () => {
      expect(errorsOf(`canvas 1\nink k "M0 0"\nink k "M1 1"\n`)[0]).toMatchObject({ line: 3 });
    });

    it("containing node that is not a group", () => {
      expect(errorsOf(`canvas 1\nnode a process "A"\nnode b process "B" in a\n`)[0]).toMatchObject({
        line: 3,
        message: 'node "a" is a process, only a group can contain nodes',
      });
    });

    it("unknown group", () => {
      expect(errorsOf(`canvas 1\nnode b process "B" in nope\n`)[0]).toMatchObject({
        line: 2,
        message: 'unknown group "nope"',
      });
    });

    it("self containment", () => {
      expect(errorsOf(`canvas 1\nnode a group "A" in a\n`)[0].message).toBe('node "a" contains itself');
    });

    it("containment cycle", () => {
      const errors = errorsOf(`canvas 1\nnode a group "A" in b\nnode b group "B" in a\n`);
      expect(errors.map((error) => error.message)).toEqual([
        'node "a" contains itself',
        'node "b" contains itself',
      ]);
    });

    it("edge to an unknown node", () => {
      expect(errorsOf(`canvas 1\nnode a process "A"\nedge a -> ghost\n`)[0]).toMatchObject({
        line: 3,
        message: 'edge references unknown node "ghost"',
      });
    });

    it("edge without an arrow", () => {
      expect(errorsOf(`canvas 1\nnode a process "A"\nedge a then b\n`)[0]).toMatchObject({
        line: 3,
        message: 'expected -> in edge, got "then"',
      });
    });

    it("edge with a missing target", () => {
      expect(errorsOf(`canvas 1\nnode a process "A"\nedge a ->\n`)[0]).toMatchObject({
        line: 3,
        message: "edge needs a source, an arrow and a target",
      });
    });

    it("at with one number", () => {
      expect(errorsOf(`canvas 1\nnode a process "A" at 10\n`)[0]).toMatchObject({ line: 2 });
      expect(errorsOf(`canvas 1\nnode a process "A" at 10\n`)[0].message).toContain("at takes two numbers");
    });

    it("at with a non number", () => {
      expect(errorsOf(`canvas 1\nnode a process "A" at x,2\n`)[0].message).toContain("at x must be a number");
    });

    it("unknown keyword", () => {
      expect(errorsOf(`canvas 1\nnode a process "A" colour red\n`)[0]).toMatchObject({
        line: 2,
        message: 'unknown node keyword "colour"',
      });
    });

    it("unknown directive", () => {
      expect(errorsOf(`canvas 1\nshape a\n`)[0]).toMatchObject({ line: 2, message: 'unknown directive "shape"' });
    });

    it("reports every bad line, not just the first", () => {
      const errors = errorsOf(`canvas 1\nnode a widget "A"\nedge a -> ghost\nink k nope\n`);
      const lines = errors.map((error) => error.line);
      expect([...new Set(lines)]).toEqual([2, 3, 4]);
      expect(lines).toEqual([...lines].sort((a, b) => a - b));
    });
  });

  it("reads archived alongside the other ink keywords, including when it ends the line", () => {
    const parsed = mustParse(`canvas 1\n\nink a "M0 0 L10 0" stroke #fff width 3 archived\n`);
    expect(parsed.ink[0]).toEqual({ id: "a", d: "M0 0 L10 0", stroke: "#fff", width: 3, archived: true });

    const trailing = mustParse(`canvas 1\n\nink a "M0 0 L10 0" archived\n`);
    expect(trailing.ink[0]).toEqual({ id: "a", d: "M0 0 L10 0", archived: true });
  });

  it("round trips archived ink, which is a sketch a compile consumed", () => {
    const scene: Scene = { nodes: [], edges: [], ink: [{ id: "a", d: "M0 0 L10 0", archived: true }] };
    const text = serializeCanvas(scene);
    expect(text).toContain('ink a "M0 0 L10 0" archived');
    expect(mustParse(text)).toEqual(scene);
  });

  it("round trips negative and fractional coordinates", () => {
    const scene: Scene = { nodes: [{ id: "a", kind: "process", label: "A", at: { x: -12.5, y: 0.25 } }], edges: [], ink: [] };
    expect(mustParse(serializeCanvas(scene))).toEqual(scene);
  });
});
