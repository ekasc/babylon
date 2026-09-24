// Sketch geometry: ink in, regions and connectors out. No model touches this.
//
// This is the "geometry (loops, arrows, containment, alignment) -> deterministic
// code" half of the compiler in docs/canvas-design-pin.md. It exists so the only
// thing a model is ever asked for is a role and a label per region, which is a
// small, croppable, verifiable question.
//
// Everything here reads the same ink the DSL stores: SVG path data. Only the
// commands a freehand capture emits are understood (move, line, close, cubic,
// quadratic). A stroke using anything else is kept whole as loose ink rather
// than guessed at.

import type { CanvasInk } from "./canvas-dsl";
import type { Point, Rect } from "./canvas-layout";

export type StrokeShape = "rect" | "ellipse";

export type Region = {
  id: string;
  /** Ink the region was built from, so a compile can mark its source. */
  inkIds: string[];
  shape: StrokeShape;
  bounds: Rect;
  /** Regions nested inside this one, innermost first. */
  contains: string[];
  parent: string | null;
};

export type Connector = {
  id: string;
  /** Null when that end of the stroke lands in empty space. */
  from: string | null;
  to: string | null;
};

export type Sketch = {
  regions: Region[];
  connectors: Connector[];
  /** Everything that is neither a region nor a connector, kept verbatim. */
  loose: CanvasInk[];
};

export type SketchReadOptions = {
  /** A loop counts as closed when its ends are this close, relative to its length. */
  closeRatio?: number;
  /** Smallest side a region may have, in points. */
  minSize?: number;
  /** How far outside a region an endpoint may land and still be attributed. */
  slack?: number;
  /** Shortest stroke that can be a connector. */
  minConnector?: number;
};

const DEFAULTS: Required<SketchReadOptions> = {
  closeRatio: 0.08,
  minSize: 12,
  slack: 14,
  minConnector: 16,
};

// Any letter tokenizes as a command, including ones this reader does not
// support, so an unknown command is rejected rather than silently skipped. A
// skipped command would silently misread every number that follows it.
const PATH_TOKEN = /-?\d*\.?\d+(?:[eE][-+]?\d+)?|[A-Za-z]/g;
const CURVE_STEPS = 8;

/** Flattens a path into a polyline. Returns null if it uses an unsupported command. */
export function parseStroke(d: string): Point[] | null {
  const tokens = d.match(PATH_TOKEN);
  if (!tokens?.length) return null;
  const points: Point[] = [];
  let index = 0;
  let command = "";
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;

  const read = (): number => Number(tokens[index++]);
  const has = (): boolean => index < tokens.length;
  const isCommand = (token: string): boolean => /^[A-Za-z]$/.test(token);

  while (index < tokens.length) {
    const tok = tokens[index];
    if (tok === undefined) break;
    if (isCommand(tok)) {
      command = tok;
      index++;
    } else if (!command) return null;

    const upper = command.toUpperCase();
    const relative = command !== upper;
    const ax = (value: number): number => (relative ? x + value : value);
    const ay = (value: number): number => (relative ? y + value : value);

    if (upper === "M") {
      if (!has()) return null;
      x = ax(read());
      y = ay(read());
      startX = x;
      startY = y;
      points.push({ x, y });
      // Further pairs after a move are implicit line-to, per the path grammar.
      command = relative ? "l" : "L";
      continue;
    }
    if (upper === "L") {
      if (!has()) return null;
      x = ax(read());
      y = ay(read());
      points.push({ x, y });
      continue;
    }
    if (upper === "H") {
      if (!has()) return null;
      x = relative ? x + read() : read();
      points.push({ x, y });
      continue;
    }
    if (upper === "V") {
      if (!has()) return null;
      y = relative ? y + read() : read();
      points.push({ x, y });
      continue;
    }
    if (upper === "Z") {
      points.push({ x: startX, y: startY });
      x = startX;
      y = startY;
      continue;
    }
    if (upper === "C" || upper === "Q") {
      const controlCount = upper === "C" ? 2 : 1;
      if (index + controlCount * 2 + 1 >= tokens.length + 1) return null;
      const controls: Point[] = [];
      for (let i = 0; i < controlCount; i++) controls.push({ x: ax(read()), y: ay(read()) });
      const end = { x: ax(read()), y: ay(read()) };
      const from = { x, y };
      const c0 = controls[0];
      if (c0 === undefined) return null;
      if (upper === "Q") flattenQuadratic(points, from, c0, end);
      else {
        const c1 = controls[1];
        if (c1 === undefined) return null;
        flattenCubic(points, from, c0, c1, end);
      }
      x = end.x;
      y = end.y;
      continue;
    }
    // Anything else (arcs, smooth curves) is left to the caller as loose ink.
    return null;
  }
  return points.length >= 2 ? points : null;
}

function flattenQuadratic(out: Point[], from: Point, control: Point, to: Point): void {
  for (let step = 1; step <= CURVE_STEPS; step++) {
    const t = step / CURVE_STEPS;
    const u = 1 - t;
    out.push({
      x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
      y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
    });
  }
}

function flattenCubic(out: Point[], from: Point, c1: Point, c2: Point, to: Point): void {
  for (let step = 1; step <= CURVE_STEPS; step++) {
    const t = step / CURVE_STEPS;
    const u = 1 - t;
    out.push({
      x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
      y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
    });
  }
}

export function boundsOfPoints(points: Point[]): Rect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export function pathLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** Shoelace area. Positive or negative by winding, so callers take the magnitude. */
export function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (current === undefined || next === undefined) continue;
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

export function isClosed(points: Point[], closeRatio: number): boolean {
  if (points.length < 4) return false;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return false;
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  return gap <= Math.max(10, closeRatio * pathLength(points));
}

/**
 * Rect or ellipse by how much of the bounding box the outline encloses: a box
 * fills it, an ellipse fills about pi/4. A scribble fills much less and is not a
 * region at all.
 */
export function shapeOfRegion(points: Point[]): StrokeShape | null {
  const bounds = boundsOfPoints(points);
  const box = bounds.width * bounds.height;
  if (box <= 0) return null;
  const fill = polygonArea(points) / box;
  if (fill >= 0.9) return "rect";
  if (fill >= 0.6) return "ellipse";
  return null;
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function holds(rect: Rect, point: Point, slack: number): boolean {
  return (
    point.x >= rect.x - slack &&
    point.x <= rect.x + rect.width + slack &&
    point.y >= rect.y - slack &&
    point.y <= rect.y + rect.height + slack
  );
}

/** Smallest region holding the point, or null when it lands in empty space. */
function regionAt(regions: Region[], point: Point, slack: number): Region | null {
  const holding = regions.filter((region) => holds(region.bounds, point, slack));
  holding.sort((left, right) => left.bounds.width * left.bounds.height - right.bounds.width * right.bounds.height);
  return holding[0] ?? null;
}

export function readSketch(ink: CanvasInk[], options: SketchReadOptions = {}): Sketch {
  const config = { ...DEFAULTS, ...options };
  const strokes: { ink: CanvasInk; points: Point[]; bounds: Rect; area: number }[] = [];
  const loose: CanvasInk[] = [];
  const open: { ink: CanvasInk; points: Point[] }[] = [];

  for (const element of ink) {
    // Archived strokes are the record of an earlier compile, not something to
    // compile again.
    if (element.archived) continue;
    const points = parseStroke(element.d);
    if (!points) {
      loose.push(element);
      continue;
    }
    const bounds = boundsOfPoints(points);
    const closed =
      bounds.width >= config.minSize &&
      bounds.height >= config.minSize &&
      isClosed(points, config.closeRatio) &&
      shapeOfRegion(points) !== null;
    if (closed) strokes.push({ ink: element, points, bounds, area: polygonArea(points) });
    else open.push({ ink: element, points });
  }

  // Reading order, so region ids are stable across runs of the same sketch.
  strokes.sort((left, right) => left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x);

  const regions: Region[] = strokes.map((stroke, index) => ({
    id: `r${index + 1}`,
    inkIds: [stroke.ink.id],
    shape: shapeOfRegion(stroke.points)!,
    bounds: stroke.bounds,
    contains: [],
    parent: null,
  }));

  for (const region of regions) {
    const own = region.bounds.width * region.bounds.height;
    // Strictly larger, so two regions with the same bounds cannot contain each other.
    const parents = regions.filter(
      (candidate) => candidate !== region && containsRect(candidate.bounds, region.bounds) && candidate.bounds.width * candidate.bounds.height > own
    );
    parents.sort((left, right) => left.bounds.width * left.bounds.height - right.bounds.width * right.bounds.height);
    region.parent = parents[0]?.id ?? null;
  }
  for (const region of regions) {
    if (!region.parent) continue;
    const parent = regions.find((candidate) => candidate.id === region.parent);
    parent?.contains.push(region.id);
  }

  const connectors: Connector[] = [];
  for (const stroke of open) {
    if (pathLength(stroke.points) < config.minConnector) {
      loose.push(stroke.ink);
      continue;
    }
    const first = stroke.points[0];
    const last = stroke.points[stroke.points.length - 1];
    if (first === undefined || last === undefined) {
      loose.push(stroke.ink);
      continue;
    }
    const from = regionAt(regions, first, config.slack);
    const to = regionAt(regions, last, config.slack);
    // A stroke that never reaches a region is a marking, not a connection, and a
    // stroke that starts and ends inside the same shape is writing or an
    // annotation rather than a link. A connector has to join two different
    // shapes, or leave one for open space.
    if ((!from && !to) || (from && to && from.id === to.id)) {
      loose.push(stroke.ink);
      continue;
    }
    connectors.push({ id: `c${connectors.length + 1}`, from: from?.id ?? null, to: to?.id ?? null });
  }

  return { regions, connectors, loose };
}
