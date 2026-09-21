// Scene to geometry. Deterministic and pure, so the canvas is reproducible from
// the file alone and two clients looking at the same file agree.
//
// Layout is a layered pass: nodes are ranked by longest path from an entry node,
// then placed rank by rank. An explicit `at` wins over the computed position,
// which is how a drag on the canvas survives a reload. Groups are not placed by
// the algorithm at all; a group is a box drawn around wherever its members ended
// up, so dragging a child reshapes its parent.
//
// The pin leaves layout authority open. This picks the version where `at` is an
// override rather than a replacement, because that is the only version where a
// human can move one node without taking over the whole scene.

import type { CanvasInk, NodeKind, Scene } from "./canvas-dsl";
import { boundsOfPoints, parseStroke } from "./sketch-geometry";

export type Point = { x: number; y: number };

export type Rect = { x: number; y: number; width: number; height: number };

export type NodeBox = Rect & { id: string; kind: NodeKind; label: string; rank: number };

export type EdgePath = {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  points: Point[];
  labelAt: Point;
};

export type SceneLayout = {
  boxes: NodeBox[];
  edges: EdgePath[];
  /** Origin of the drawn area. Boxes keep absolute coordinates, so a scene
   *  dragged far from the origin needs this to stay in view. */
  x: number;
  y: number;
  width: number;
  height: number;
};

const NODE_HEIGHT = 44;
const MIN_WIDTH = 104;
const MAX_WIDTH = 264;
const CHAR_WIDTH = 7.2;
const LABEL_PADDING = 32;
const RANK_GAP = 76;
const SIBLING_GAP = 28;
const GROUP_PADDING = 18;
const GROUP_TITLE = 28;
const MARGIN = 24;
const LOOP = 36;

/** Extent of everything drawn, so the view can frame it. */
function inkBounds(ink: CanvasInk[]): Rect | null {
  const points = ink.filter((element) => !element.archived).flatMap((element) => parseStroke(element.d) ?? []);
  return points.length ? boundsOfPoints(points) : null;
}

/** Wide enough for the label, clamped, so one long label cannot own the canvas. */
export function boxWidth(label: string): number {
  const longest = label.split("\n").reduce((widest, line) => Math.max(widest, line.length), 0);
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(longest * CHAR_WIDTH) + LABEL_PADDING));
}

/**
 * Longest distance from an entry node. A cycle is cut where it is revisited, so
 * a back edge is ignored rather than ranked.
 */
export function rankNodes(ids: string[], predecessors: Map<string, string[]>): Map<string, number> {
  const ranks = new Map<string, number>();
  const done = new Set<string>();
  const visit = (id: string, stack: Set<string>): number => {
    if (done.has(id)) return ranks.get(id) ?? 0;
    if (stack.has(id)) return -1;
    stack.add(id);
    let best = 0;
    for (const previous of predecessors.get(id) ?? []) best = Math.max(best, visit(previous, stack) + 1);
    stack.delete(id);
    done.add(id);
    ranks.set(id, best);
    return best;
  };
  for (const id of ids) visit(id, new Set());
  return ranks;
}

/** Where the segment from the rect's centre toward `toward` crosses the border. */
function clipToRect(rect: Rect, toward: Point): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : rect.width / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : rect.height / 2 / Math.abs(dy)
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function boundsOf(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function layoutScene(scene: Scene): SceneLayout {
  const groupMembers = new Map<string, string[]>();
  const leaves = scene.nodes.filter((node) => {
    if (node.kind !== "group") return true;
    groupMembers.set(node.id, []);
    return false;
  });
  const leafIds = new Set(leaves.map((node) => node.id));
  for (const node of scene.nodes) {
    if (!node.in) continue;
    groupMembers.get(node.in)?.push(node.id);
  }
  // A group's box covers the leaves of any group nested inside it.
  const leavesUnder = (groupId: string): string[] =>
    (groupMembers.get(groupId) ?? []).flatMap((id) => (leafIds.has(id) ? [id] : leavesUnder(id)));

  const predecessors = new Map<string, string[]>(leaves.map((node) => [node.id, []]));
  for (const edge of scene.edges) {
    if (!leafIds.has(edge.from) || !leafIds.has(edge.to) || edge.from === edge.to) continue;
    predecessors.get(edge.to)?.push(edge.from);
  }
  const ranks = rankNodes(
    leaves.map((node) => node.id),
    predecessors
  );

  const sizes = new Map(leaves.map((node) => [node.id, boxWidth(node.label)]));
  const horizontal = scene.direction === "LR";
  const rankCount = ranks.size ? Math.max(...ranks.values()) + 1 : 0;
  const columns: string[][] = Array.from({ length: rankCount }, () => []);
  for (const node of leaves) {
    const col = columns[ranks.get(node.id) ?? 0];
    if (col !== undefined) col.push(node.id);
  }

  const spanOf = (ids: string[]) =>
    ids.reduce((total, id) => total + (sizes.get(id) ?? MIN_WIDTH), 0) + SIBLING_GAP * Math.max(0, ids.length - 1);
  const spans = columns.map(spanOf);
  const widestSpan = Math.max(0, ...spans);

  // Along the rank axis each rank advances by its own thickness: a node's height
  // when ranks are rows, its width when ranks are columns.
  const offsets: number[] = [];
  let offset = 0;
  for (const ids of columns) {
    offsets.push(offset);
    const thickness = horizontal
      ? Math.max(NODE_HEIGHT, ...ids.map((id) => sizes.get(id) ?? MIN_WIDTH))
      : NODE_HEIGHT;
    offset += thickness + RANK_GAP;
  }

  const placed = new Map<string, Rect>();
  columns.forEach((ids, index) => {
    let cross = (widestSpan - (spans[index] ?? 0)) / 2;
    for (const id of ids) {
      const width = sizes.get(id) ?? MIN_WIDTH;
      placed.set(
        id,
        horizontal
          ? { x: MARGIN + (offsets[index] ?? 0), y: MARGIN + cross, width, height: NODE_HEIGHT }
          : { x: MARGIN + cross, y: MARGIN + (offsets[index] ?? 0), width, height: NODE_HEIGHT }
      );
      cross += width + SIBLING_GAP;
    }
  });

  // An explicit position is the human's, and it wins over the computed one.
  for (const node of leaves) {
    if (!node.at) continue;
    const rect = placed.get(node.id);
    if (rect) placed.set(node.id, { ...rect, x: node.at.x, y: node.at.y });
  }

  const rects = new Map(placed);
  for (const node of scene.nodes) {
    if (node.kind !== "group") continue;
    const members = leavesUnder(node.id).flatMap((id) => {
      const rect = rects.get(id);
      return rect ? [rect] : [];
    });
    const box = members.length
      ? boundsOf(members)
      : { x: MARGIN, y: MARGIN, width: MIN_WIDTH, height: NODE_HEIGHT - GROUP_TITLE - GROUP_PADDING };
    rects.set(node.id, {
      x: box.x - GROUP_PADDING,
      y: box.y - GROUP_PADDING - GROUP_TITLE,
      width: box.width + GROUP_PADDING * 2,
      height: box.height + GROUP_PADDING * 2 + GROUP_TITLE,
    });
  }

  const edges: EdgePath[] = [];
  for (const edge of scene.edges) {
    const from = rects.get(edge.from);
    const to = rects.get(edge.to);
    if (!from || !to) continue;
    const centre = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    const points =
      edge.from === edge.to
        ? [
            { x: from.x + from.width, y: from.y + from.height * 0.35 },
            { x: from.x + from.width + LOOP, y: from.y + from.height * 0.35 },
            { x: from.x + from.width + LOOP, y: from.y - LOOP / 2 },
            { x: from.x + from.width * 0.6, y: from.y },
          ]
        : [clipToRect(from, centre(to)), clipToRect(to, centre(from))];
    const first = points[0];
    const last = points[points.length - 1];
    if (first === undefined || last === undefined) continue;
    edges.push({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      dashed: edge.dashed,
      points,
      labelAt: { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 },
    });
  }

  const boxes: NodeBox[] = [];
  for (const node of scene.nodes) {
    const rect = rects.get(node.id);
    if (!rect) continue;
    boxes.push({ id: node.id, kind: node.kind, label: node.label, rank: ranks.get(node.id) ?? -1, ...rect });
  }

  // The frame has to hold the drawing as well as the nodes compiled from it,
  // otherwise a sketch that reaches past its nodes is cut off at the edge.
  const frame = boxes.map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height }));
  const ink = inkBounds(scene.ink);
  if (ink) frame.push(ink);
  const envelope = frame.length ? boundsOf(frame) : { x: 0, y: 0, width: 0, height: 0 };
  return {
    boxes,
    edges,
    x: envelope.x - MARGIN,
    y: envelope.y - MARGIN,
    width: envelope.width + MARGIN * 2,
    height: envelope.height + MARGIN * 2,
  };
}
