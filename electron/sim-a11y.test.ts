import { describe, expect, it } from "vitest";
import { AX_MAX_NODES, condenseAxTree, parseAxRefSelector, type AxNodeJson } from "./sim-a11y";

function node(partial: Partial<AxNodeJson> & { nodeId: string }): AxNodeJson {
  return partial;
}

const TREE: AxNodeJson[] = [
  node({ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Shop" }, childIds: ["2", "3", "6"] }),
  node({ nodeId: "2", role: { value: "heading" }, name: { value: "Welcome" }, backendDOMNodeId: 11 }),
  node({ nodeId: "3", role: { value: "Generic" }, childIds: ["4", "5"] }),
  node({ nodeId: "4", role: { value: "StaticText" }, name: { value: "Some prose already in the text snapshot." } }),
  node({ nodeId: "5", role: { value: "link" }, name: { value: "Docs" }, backendDOMNodeId: 12 }),
  node({ nodeId: "6", role: { value: "textbox" }, name: { value: "Search" }, value: { value: "" }, backendDOMNodeId: 13 }),
];

describe("condenseAxTree", () => {
  it("emits interactive nodes with sequential refs, skipping static text", () => {
    const out = condenseAxTree(TREE);
    expect(out.text).toBe(
      ['RootWebArea "Shop"', '[1] heading "Welcome"', '[2] link "Docs"', '[3] textbox "Search"'].join("\n")
    );
    expect(out.refs).toEqual([
      { ref: 1, backendDOMNodeId: 11 },
      { ref: 2, backendDOMNodeId: 12 },
      { ref: 3, backendDOMNodeId: 13 },
    ]);
    expect(out.truncated).toBe(false);
  });

  it("skips ignored subtrees entirely", () => {
    const nodes: AxNodeJson[] = [
      node({ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3"] }),
      node({ nodeId: "2", role: { value: "button" }, name: { value: "Hidden" }, ignored: true, childIds: ["4"], backendDOMNodeId: 21 }),
      node({ nodeId: "4", role: { value: "button" }, name: { value: "Nested" }, backendDOMNodeId: 22 }),
      node({ nodeId: "3", role: { value: "button" }, name: { value: "Shown" }, backendDOMNodeId: 23 }),
    ];
    const out = condenseAxTree(nodes);
    expect(out.text).toContain("Shown");
    expect(out.text).not.toContain("Hidden");
    expect(out.text).not.toContain("Nested");
  });

  it("caps nodes with a truncation note", () => {
    const nodes: AxNodeJson[] = [{ nodeId: "root", role: { value: "RootWebArea" }, childIds: [] }];
    for (let i = 0; i < AX_MAX_NODES + 10; i++) {
      const id = `n${i}`;
      nodes.push(node({ nodeId: id, role: { value: "button" }, name: { value: `B${i}` }, backendDOMNodeId: 100 + i }));
      (nodes[0].childIds as string[]).push(id);
    }
    const out = condenseAxTree(nodes);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("… (");
  });
});

describe("parseAxRefSelector", () => {
  it("accepts ref:N", () => {
    expect(parseAxRefSelector("ref:3")).toBe(3);
    expect(parseAxRefSelector("  ref:12 ")).toBe(12);
  });

  it("rejects CSS and malformed refs", () => {
    expect(parseAxRefSelector("button.submit")).toBeNull();
    expect(parseAxRefSelector("ref:0")).toBeNull();
    expect(parseAxRefSelector("ref:abc")).toBeNull();
    expect(parseAxRefSelector("ref:")).toBeNull();
  });
});
