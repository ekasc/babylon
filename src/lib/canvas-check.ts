import { parseCanvas, type Scene } from "./canvas-dsl";
import { layoutScene, type Point, type Rect } from "./canvas-layout";

// The agent writes scenes blind, so diagrams come back with overlapping boxes
// and colliding labels. This is the feedback signal: parse errors plus the
// layout problems the renderer would show, with exact ids, in compact text the
// agent can act on. Pure, so the daemon tools and the tests share it.

export type CanvasOverlap = { a: string; b: string };

export type CanvasLabelCollision = { edge: string; node: string };

export type CanvasCheckReport = {
  ok: boolean;
  errors: { line: number; message: string }[];
  overlaps: CanvasOverlap[];
  overlapCount: number;
  labelCollisions: CanvasLabelCollision[];
  labelCollisionCount: number;
  nodes: number;
  edges: number;
  groups: number;
  width: number;
  height: number;
};

/** How many of each finding list to spell out; totals always follow. */
const MAX_ITEMS = 8;

function interiorsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function pointIn(rect: Rect, point: Point, pad: number): boolean {
  return (
    point.x >= rect.x - pad &&
    point.x <= rect.x + rect.width + pad &&
    point.y >= rect.y - pad &&
    point.y <= rect.y + rect.height + pad
  );
}

/** True when id sits inside groupId through any depth of `in` nesting. */
function under(scene: Scene, id: string, groupId: string): boolean {
  const parent = new Map(scene.nodes.map((node) => [node.id, node.in]));
  let current = parent.get(id);
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === groupId) return true;
    seen.add(current);
    current = parent.get(current);
  }
  return false;
}

export function checkCanvasText(text: string): CanvasCheckReport {
  const parsed = parseCanvas(text);
  const empty: CanvasCheckReport = {
    ok: false,
    errors: [],
    overlaps: [],
    overlapCount: 0,
    labelCollisions: [],
    labelCollisionCount: 0,
    nodes: 0,
    edges: 0,
    groups: 0,
    width: 0,
    height: 0,
  };
  if (!parsed.ok) return { ...empty, errors: parsed.errors };
  const scene = parsed.scene;
  const layout = layoutScene(scene);
  const boxes = new Map(layout.boxes.map((box) => [box.id, box]));

  const overlaps: CanvasOverlap[] = [];
  const ids = [...boxes.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      // A group contains its members by design; only siblings collide.
      if (under(scene, a, b) || under(scene, b, a)) continue;
      const ra = boxes.get(a)!;
      const rb = boxes.get(b)!;
      if (interiorsIntersect(ra, rb)) overlaps.push({ a, b });
    }
  }

  const labelCollisions: CanvasLabelCollision[] = [];
  for (const edge of layout.edges) {
    if (!edge.label) continue;
    for (const [id, rect] of boxes) {
      if (id === edge.from || id === edge.to) continue;
      if (pointIn(rect, edge.labelAt, 3)) {
        labelCollisions.push({ edge: `${edge.from}->${edge.to}`, node: id });
        break;
      }
    }
  }

  return {
    ok: true,
    errors: [],
    overlaps: overlaps.slice(0, MAX_ITEMS),
    overlapCount: overlaps.length,
    labelCollisions: labelCollisions.slice(0, MAX_ITEMS),
    labelCollisionCount: labelCollisions.length,
    nodes: scene.nodes.filter((node) => node.kind !== "group").length,
    edges: scene.edges.length,
    groups: scene.nodes.filter((node) => node.kind === "group").length,
    width: Math.round(layout.width),
    height: Math.round(layout.height),
  };
}

/** Compact text for the agent: findings first, totals always, capped lists. */
export function formatCheckReport(report: CanvasCheckReport): string {
  if (!report.ok) {
    return [`canvas_check: invalid (${report.errors.length} errors)`, ...report.errors.map((e) => `line ${e.line}: ${e.message}`)].join("\n");
  }
  const lines = [
    `canvas_check: ok — ${report.nodes} nodes, ${report.edges} edges, ${report.groups} groups, ${report.width}x${report.height}`,
  ];
  for (const o of report.overlaps) lines.push(`overlap: ${o.a} ${o.b}`);
  if (report.overlapCount > report.overlaps.length) {
    lines.push(`... and ${report.overlapCount - report.overlaps.length} more overlaps`);
  }
  for (const c of report.labelCollisions) lines.push(`label-collision: edge ${c.edge} with node ${c.node}`);
  if (report.labelCollisionCount > report.labelCollisions.length) {
    lines.push(`... and ${report.labelCollisionCount - report.labelCollisions.length} more label collisions`);
  }
  if (report.overlapCount === 0 && report.labelCollisionCount === 0) lines.push("clean: no overlaps or label collisions");
  return lines.join("\n");
}
