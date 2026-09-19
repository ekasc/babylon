// The crop a classifier is asked about, and which strokes belong in it.
//
// The ink is vector, so a region's crop is built from its own strokes rather
// than screenshotted. That matters twice: the crop is exact and repeatable, and
// reading a sketch never means shipping a picture of the user's screen.
//
// The crop is a question, not a rendering. Handwriting has to be legible to a
// model, so the crop is forced to dark strokes on white whatever the app theme
// is, and it is scaled up when a region is small.

import type { CanvasInk } from "./canvas-dsl";
import { parseStroke, type Region } from "./sketch-geometry";

export type CropOptions = {
  /** Ink-free border around the region, in scene units. */
  padding?: number;
  /** Pixels per scene unit. Defaults to whatever makes the crop readable. */
  scale?: number;
};

export type RegionCrop = {
  regionId: string;
  /** Crop size in pixels. */
  width: number;
  height: number;
  /** Self-contained SVG markup, ready to rasterize. */
  svg: string;
};

const DEFAULT_PADDING = 12;
/** A crop narrower than this is scaled up, so handwriting stays readable. */
const READABLE_PX = 320;
const MAX_SCALE = 4;
const CROP_STROKE = "#111111";
const CROP_BACKGROUND = "#ffffff";
const BORDER_SLACK = 2;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Strokes lying wholly inside the region, which is what the crop shows. */
export function strokesWithin(ink: CanvasInk[], region: Region, slack = BORDER_SLACK): CanvasInk[] {
  const left = region.bounds.x - slack;
  const top = region.bounds.y - slack;
  const right = region.bounds.x + region.bounds.width + slack;
  const bottom = region.bounds.y + region.bounds.height + slack;
  return ink.filter((element) => {
    const points = parseStroke(element.d);
    // A stroke that cannot be read cannot be shown to be inside, so it is left out.
    if (!points) return false;
    return points.every((point) => point.x >= left && point.x <= right && point.y >= top && point.y <= bottom);
  });
}

export function cropScale(region: Region, padding: number): number {
  const longest = Math.max(region.bounds.width, region.bounds.height) + padding * 2;
  if (longest <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(1, READABLE_PX / longest));
}

export function regionCrop(ink: CanvasInk[], region: Region, options: CropOptions = {}): RegionCrop {
  const padding = options.padding ?? DEFAULT_PADDING;
  const view = {
    x: region.bounds.x - padding,
    y: region.bounds.y - padding,
    width: region.bounds.width + padding * 2,
    height: region.bounds.height + padding * 2,
  };
  const scale = options.scale ?? cropScale(region, padding);
  const strokes = strokesWithin(ink, region)
    .map((element) => `<path d="${escapeXml(element.d)}"/>`)
    .join("");
  return {
    regionId: region.id,
    width: Math.round(view.width * scale),
    height: Math.round(view.height * scale),
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(view.width * scale)}" height="${Math.round(view.height * scale)}" ` +
      `viewBox="${view.x} ${view.y} ${view.width} ${view.height}">` +
      `<rect x="${view.x}" y="${view.y}" width="${view.width}" height="${view.height}" fill="${CROP_BACKGROUND}"/>` +
      `<g fill="none" stroke="${CROP_STROKE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${strokes}</g>` +
      `</svg>`,
  };
}
