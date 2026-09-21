// The v1 canvas flow: a Mermaid block becomes an editable scene. Mermaid already
// parses its own source, so this reads its flowchart database instead of parsing
// text. Vertex shapes choose the node kind, subgraphs become groups, and link
// strokes choose solid or dashed.
//
// Two losses are deliberate, because the DSL is narrower than Mermaid and the
// round trip has to stay honest about it:
//   - `thick` links render solid; the DSL carries one dashed flag, not a stroke
//     vocabulary.
//   - `BT` and `RL` fold to `TB`; the DSL carries one axis, not a rankdir.

import type { CanvasDirection, CanvasEdge, CanvasNode, NodeKind, Scene } from "./canvas-dsl";

/** The slice of Mermaid's flowchart database this importer reads. */
export type MermaidVertex = { id: string; text?: string; type?: string };
export type MermaidEdge = { start: string; end: string; text?: string; stroke?: string };
export type MermaidSubGraph = { id: string; title?: string; nodes?: string[] };

export type MermaidGraph = {
  vertices: MermaidVertex[];
  edges: MermaidEdge[];
  subGraphs: MermaidSubGraph[];
  direction?: string;
};

// Both shape vocabularies Mermaid uses. Flowchart source names its own shapes
// (`diamond`, `stadium`), while the rendering layer prefers `ShapeID` names
// (`question`, `squareRect`) and a vertex may carry either.
const KIND_BY_SHAPE: Record<string, NodeKind> = {
  diamond: "decision",
  question: "decision",
  stadium: "terminator",
  doublecircle: "terminator",
  cylinder: "data",
  cylindric: "data",
};

/** Everything unmapped is a box, which is what `process` means. */
export function kindForShape(shape: string | undefined): NodeKind {
  if (!shape) return "process";
  return KIND_BY_SHAPE[shape] ?? "process";
}

export function directionFor(direction: string | undefined): CanvasDirection {
  return direction === "LR" ? "LR" : "TB";
}

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/**
 * Mermaid labels are HTML. `<br>` becomes a space rather than a newline because
 * the canvas draws single-line labels, and inline markup (`<b>`) is decoration
 * that the canvas does not render anyway.
 */
export function plainLabel(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    // Decoded last so that `&amp;lt;` becomes `&lt;` rather than `<`.
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const ID_SAFE = /[^A-Za-z0-9_.-]/g;

/** Mermaid ids are freer than canvas ids, so they are mapped, never trusted. */
export function canvasIdMap(graph: MermaidGraph): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  const assign = (raw: string): void => {
    if (map.has(raw)) return;
    let base = raw.replace(ID_SAFE, "_");
    if (!/^[A-Za-z_]/.test(base)) base = `n_${base}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}_${suffix++}`;
    used.add(candidate);
    map.set(raw, candidate);
  };
  for (const subGraph of graph.subGraphs) assign(subGraph.id);
  for (const vertex of graph.vertices) assign(vertex.id);
  return map;
}

export function sceneFromMermaid(graph: MermaidGraph): Scene {
  const ids = canvasIdMap(graph);
  // canvasIdMap assigns every vertex and subgraph id iterated below, so a
  // miss here is an internal inconsistency, not a data case.
  const need = (key: string): string => {
    const v = ids.get(key);
    if (v === undefined) throw new Error(`missing canvas id for ${key}`);
    return v;
  };
  const subGraphIds = new Set(graph.subGraphs.map((subGraph) => subGraph.id));

  const nodes: CanvasNode[] = [];
  for (const subGraph of graph.subGraphs) {
    const id = need(subGraph.id);
    nodes.push({ id, kind: "group", label: plainLabel(subGraph.title) || id });
  }
  for (const vertex of graph.vertices) {
    // A subgraph also appears in the vertex map. The group node already covers it.
    if (subGraphIds.has(vertex.id)) continue;
    const id = need(vertex.id);
    nodes.push({ id, kind: kindForShape(vertex.type), label: plainLabel(vertex.text) || id });
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const subGraph of graph.subGraphs) {
    const parent = need(subGraph.id);
    // A node can only sit in one group, so the last subgraph listing it wins.
    for (const child of subGraph.nodes ?? []) {
      const childId = ids.get(child);
      if (!childId || childId === parent) continue;
      const node = byId.get(childId);
      if (node) node.in = parent;
    }
  }

  const edges: CanvasEdge[] = [];
  for (const edge of graph.edges) {
    const from = ids.get(edge.start);
    const to = ids.get(edge.end);
    // Never emit a reference the scene cannot resolve, since the DSL rejects those.
    if (!from || !to || !byId.has(from) || !byId.has(to)) continue;
    const label = plainLabel(edge.text);
    edges.push({ from, to, ...(label ? { label } : {}), ...(edge.stroke === "dotted" ? { dashed: true } : {}) });
  }

  return { nodes, edges, ink: [], direction: directionFor(graph.direction) };
}

type MermaidFlowDb = {
  getVertices?: () => Map<string, MermaidVertex>;
  getEdges?: () => MermaidEdge[];
  getSubGraphs?: () => MermaidSubGraph[];
  getDirection?: () => string | undefined;
};

/** Reads Mermaid's own parse of the text. Loads Mermaid lazily, as the view does. */
export async function mermaidGraphFromText(text: string): Promise<MermaidGraph> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  const diagram = (await mermaid.mermaidAPI.getDiagramFromText(text)) as {
    db?: MermaidFlowDb;
  };
  const db = diagram.db;
  if (!db?.getVertices || !db.getEdges) {
    throw new Error("Only Mermaid flowcharts can be opened on the canvas.");
  }
  return {
    vertices: [...db.getVertices().values()],
    edges: db.getEdges(),
    subGraphs: db.getSubGraphs?.() ?? [],
    direction: db.getDirection?.(),
  };
}

export async function sceneFromMermaidText(text: string): Promise<Scene> {
  return sceneFromMermaid(await mermaidGraphFromText(text));
}
