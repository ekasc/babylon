// Local rasterizer for Snapcompact frames.
//
// Pure Node, no native dependencies, no third-party graphics library.
// Renders monospaced 5x7 text into monochrome PNG frames at a fixed
// pixel size. Frames are produced by an explicit frame plan
// (frame-plan.ts) so no rendered frame can contain silent holes.
//
// Determinism: given the same source text, the same profile, and the
// same symbol dictionary, the produced PNG bytes are byte-identical.

import { encodePng1Bit, fillRect } from "./png-encoder";
import { FONT_5X7, GLYPH_W, GLYPH_H } from "./font";
import { assignIds, type RawSymbol } from "./symbol-dictionary";
import { planFrames, type FramePlan } from "./frame-plan";
import type { SnapcompactFrame, SnapcompactSymbol } from "./types";

export interface FrameProfile {
  id: string;
  width: number;
  height: number;
  fontScale: number;
  lineGap: number;
  marginX: number;
  marginY: number;
  maxFrames: number;
}

export const MIN_SUBSTITUTION_LEN = 12;
const SUBSTITUTION_HINT = (id: string) => `[${id}]`;

export function applySubstitution(sourceText: string, symbols: SnapcompactSymbol[]): string {
  if (!symbols.length) return sourceText;
  let out = sourceText;
  for (const s of symbols) {
    if (s.value.length < MIN_SUBSTITUTION_LEN) continue;
    out = replaceAfterFirst(out, s.value, SUBSTITUTION_HINT(s.id));
  }
  return out;
}

function replaceAfterFirst(text: string, value: string, replacement: string): string {
  const first = text.indexOf(value);
  if (first < 0) return text;
  let out = text.slice(0, first + value.length);
  let cursor = first + value.length;
  while (true) {
    const next = text.indexOf(value, cursor);
    if (next < 0) { out += text.slice(cursor); break; }
    out += text.slice(cursor, next) + replacement;
    cursor = next + value.length;
  }
  return out;
}

export function wrapLines(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) { out.push(""); continue; }
    let i = 0;
    while (i < rawLine.length) {
      let end = Math.min(i + cols, rawLine.length);
      if (end < rawLine.length) {
        const breakAt = rawLine.lastIndexOf(" ", end);
        if (breakAt > i + 4) end = breakAt + 1;
      }
      out.push(rawLine.slice(i, end));
      i = end;
    }
  }
  return out;
}

function renderLinesToPng(
  width: number,
  height: number,
  lines: string[],
  profile: FrameProfile,
): Buffer {
  const pixels = new Uint8Array(Math.ceil(width / 8) * height);
  pixels.fill(0xFF);
  const scale = profile.fontScale;
  const cellW = GLYPH_W * scale + profile.lineGap;
  const cellH = GLYPH_H * scale + Math.max(1, profile.lineGap);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const y = profile.marginY + li * cellH;
    if (y + GLYPH_H * scale > height) break;
    let x = profile.marginX;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      const g = FONT_5X7[ch] ?? FONT_5X7[" "];
      for (let row = 0; row < GLYPH_H; row++) {
        for (let col = 0; col < GLYPH_W; col++) {
          if (g[row][col] === "X") {
            fillRect(pixels, width, height, x + col * scale, y + row * scale, scale, scale, true);
          }
        }
      }
      x += cellW;
      if (x + GLYPH_W * scale > width) break;
    }
  }
  return encodePng1Bit(width, height, pixels);
}

export interface RenderInput {
  sourceText: string;
  rawSymbols: RawSymbol[];
  profile: FrameProfile;
}

export interface RenderResult {
  frames: SnapcompactFrame[];
  symbols: SnapcompactSymbol[];
  adjustedSourceText: string;
  plan: FramePlan;
  truncated: boolean;
}

export function renderFrames(input: RenderInput): RenderResult {
  const symbols = assignIds(input.rawSymbols);
  const adjusted = applySubstitution(input.sourceText, symbols);
  const plan = planFrames(adjusted, input.profile);
  const frames: SnapcompactFrame[] = plan.entries.map((entry) => {
    const slice = entry.carriesOmission
      ? [plan.omitted.marker]
      : plan.wrappedLines.slice(entry.lineStart, entry.lineEnd + 1);
    const png = renderLinesToPng(entry.width, entry.height, slice, input.profile);
    return {
      index: entry.index,
      width: entry.width,
      height: entry.height,
      png,
      sourceOffset: entry.lineStart,
      sourceEnd: entry.lineEnd + 1,
    };
  });
  return { frames, symbols, adjustedSourceText: adjusted, plan, truncated: plan.omitted.marker !== "" };
}
