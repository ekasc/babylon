// The Region to Node contract. Deterministic: given regions and readings it
// always produces the same scene and the same change list.
//
// The division of labour is the point. Geometry decides what is a shape, what
// holds what, and what connects to what (sketch-geometry.ts). A model decides
// only what a region means and what it says, from a crop. Assembly happens here,
// and the model never writes the DSL: it answers a closed question about one
// crop, and this file turns the answers into nodes.
//
// Ambiguity is a result, not a failure. A region whose role is not confident is
// still drawn, as a plain box, and reported in `unsure` so a human settles it.
// Inventing a specific role is the failure mode this shape exists to prevent.

import { NODE_KINDS, type CanvasEdge, type CanvasNode, type NodeKind, type Scene } from "./canvas-dsl";
import type { Region, Sketch } from "./sketch-geometry";

/** What a classifier may answer. `unknown` is a real answer, not an error. */
export const REGION_ROLES = [...NODE_KINDS, "unknown"] as const;
export type RegionRole = (typeof REGION_ROLES)[number];

export type RegionReading = {
  role: RegionRole;
  /** The text written in the region, verbatim. Empty when there is none. */
  label: string;
  /** 0 to 1. Below the floor the role is treated as unread. */
  confidence: number;
};

/**
 * The seam with the model: one region in, one reading out. The real
 * implementation crops the region and asks a VLM; tests pass a function.
 */
export type RegionClassifier = (region: Region) => Promise<RegionReading>;

export type SketchUncertainty = {
  /** Region or connector id that needs a human decision. */
  id: string;
  label: string;
  reason: string;
};

export type SceneChange =
  | { kind: "node-added"; id: string; label: string; nodeKind: NodeKind }
  | { kind: "node-removed"; id: string; label: string }
  | { kind: "node-relabelled"; id: string; from: string; to: string }
  | { kind: "node-retyped"; id: string; from: NodeKind; to: NodeKind }
  | { kind: "edge-added"; from: string; to: string }
  | { kind: "edge-removed"; from: string; to: string };

export type CompileOptions = {
  confidenceFloor?: number;
  /** Inset applied to the sketch's own origin, so a compiled scene starts at the margin. */
  margin?: number;
};

export type CompileResult = {
  scene: Scene;
  unsure: SketchUncertainty[];
  /** What applying this scene would change. The caller confirms before applying. */
  changes: SceneChange[];
};

const DEFAULTS = { confidenceFloor: 0.5, margin: 24 };

/** Runs a classifier over every region, and treats a failure as a reading it could not make. */
export async function readRegions(regions: Region[], classify: RegionClassifier): Promise<Map<string, RegionReading>> {
  const readings = new Map<string, RegionReading>();
  await Promise.all(
    regions.map(async (region) => {
      try {
        readings.set(region.id, await classify(region));
      } catch {
        // No reading means the region shows up in `unsure`, which is better than
        // a failed compile or a guessed role.
      }
    })
  );
  return readings;
}

const labelKey = (label: string): string => label.trim().toLowerCase();

function slug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueId(base: string, used: Set<string>): string {
  const normalised = /^[A-Za-z_]/.test(base) ? base : `n-${base || "node"}`;
  let candidate = normalised;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${normalised}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

export function compileSketch(
  sketch: Sketch,
  readings: Map<string, RegionReading>,
  existing?: Scene,
  options: CompileOptions = {}
): CompileResult {
  const config = { ...DEFAULTS, ...options };
  const unsure: SketchUncertainty[] = [];
  const changes: SceneChange[] = [];

  // The sketch is joined to the scene by the text in the boxes. It is the only
  // stable link between a drawing and an existing scene, and reusing the matched
  // node's id is what keeps a recompile from churning every reference.
  const unclaimed = new Map<string, CanvasNode>();
  for (const node of existing?.nodes ?? []) unclaimed.set(labelKey(node.label), node);

  // Sketch coordinates are the drawing's own space, so the arrangement is kept
  // but re-anchored: relative placement survives, the arbitrary origin does not.
  const minX = Math.min(...sketch.regions.map((region) => region.bounds.x));
  const minY = Math.min(...sketch.regions.map((region) => region.bounds.y));
  const originX = Number.isFinite(minX) ? minX : 0;
  const originY = Number.isFinite(minY) ? minY : 0;

  const used = new Set((existing?.nodes ?? []).map((node) => node.id));
  const nodeIdOf = new Map<string, string>();
  const nodes: CanvasNode[] = [];

  for (const region of sketch.regions) {
    const reading = readings.get(region.id);
    const label = reading?.label.trim() ?? "";
    const certain = reading && reading.role !== "unknown" && reading.confidence >= config.confidenceFloor;
    const holdsSomething = region.contains.length > 0;

    let kind: NodeKind;
    if (holdsSomething) {
      // Containment is geometry, so it outranks the reading: only a group can
      // hold nodes. A reading that disagrees is worth a human's attention.
      kind = "group";
      if (certain && reading.role !== "group") {
        unsure.push({
          id: region.id,
          label,
          reason: `read as ${reading.role}, but other shapes are drawn inside it, so it compiles to a group`,
        });
      }
    } else if (certain) {
      kind = reading.role as NodeKind;
    } else {
      // Draw it, do not name it. A plain box keeps the sketch visible and the
      // question explicit.
      kind = "process";
      unsure.push({
        id: region.id,
        label,
        reason: reading ? `the role ${reading.role} was not confident enough` : "no reading was produced for this shape",
      });
    }

    const match = label ? unclaimed.get(labelKey(label)) : undefined;
    if (match) unclaimed.delete(labelKey(label));
    const id = match ? match.id : uniqueId(slug(label) || region.id, used);

    nodeIdOf.set(region.id, id);
    nodes.push({
      id,
      kind,
      label: label || id,
      at: { x: Math.round(region.bounds.x - originX + config.margin), y: Math.round(region.bounds.y - originY + config.margin) },
    });
  }

  // Containment is resolved after every id exists, so a child never depends on
  // the order regions were drawn in.
  for (const region of sketch.regions) {
    if (!region.parent) continue;
    const node = nodes.find((candidate) => candidate.id === nodeIdOf.get(region.id));
    const parent = nodeIdOf.get(region.parent);
    if (node && parent) node.in = parent;
  }

  const edges: CanvasEdge[] = [];
  for (const connector of sketch.connectors) {
    const from = connector.from ? nodeIdOf.get(connector.from) : undefined;
    const to = connector.to ? nodeIdOf.get(connector.to) : undefined;
    if (!from || !to) {
      unsure.push({ id: connector.id, label: "", reason: "one end of this line does not land on a shape" });
      continue;
    }
    edges.push({ from, to });
  }

  // Anything the sketch did not draw is reported as removed rather than deleted
  // quietly. Applying a compile is a decision the human makes from this list.
  const previousNodes = new Map((existing?.nodes ?? []).map((node) => [node.id, node]));
  for (const node of nodes) {
    const previous = previousNodes.get(node.id);
    if (!previous) {
      changes.push({ kind: "node-added", id: node.id, label: node.label, nodeKind: node.kind });
      continue;
    }
    if (previous.kind !== node.kind) changes.push({ kind: "node-retyped", id: node.id, from: previous.kind, to: node.kind });
    if (previous.label !== node.label) changes.push({ kind: "node-relabelled", id: node.id, from: previous.label, to: node.label });
  }
  const compiledIds = new Set(nodes.map((node) => node.id));
  for (const node of existing?.nodes ?? []) {
    if (!compiledIds.has(node.id)) changes.push({ kind: "node-removed", id: node.id, label: node.label });
  }

  const key = (edge: { from: string; to: string }): string => `${edge.from}\u0000${edge.to}`;
  const previousEdges = new Set((existing?.edges ?? []).map(key));
  const compiledEdges = new Set(edges.map(key));
  for (const edge of edges) if (!previousEdges.has(key(edge))) changes.push({ kind: "edge-added", from: edge.from, to: edge.to });
  for (const edge of existing?.edges ?? []) {
    if (!compiledEdges.has(key(edge))) changes.push({ kind: "edge-removed", from: edge.from, to: edge.to });
  }

  return { scene: { nodes, edges, ink: sketch.loose }, unsure, changes };
}
