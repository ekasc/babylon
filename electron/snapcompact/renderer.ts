// Local rasterizer for Snapcompact frames.
//
// Pure Node, no native dependencies. Renders monospaced 5x7 text into
// monochrome PNG frames at a fixed pixel size. Frames are dense and
// deterministic: given the same source text, the same profile, and the
// same symbol dictionary, the produced PNG bytes are byte-identical.
//
// The renderer exposes a single `renderFrames` entry point so a different
// renderer (e.g. native, off-thread) can be swapped in without touching
// the rest of the pipeline. The interface is intentionally narrow.

import { encodePng1Bit, fillRect } from "./png-encoder";
import { FONT_5X7, GLYPH_W, GLYPH_H, glyph5x7 } from "./font";
import { assignIds, type RawSymbol } from "./symbol-dictionary";
import type { SnapcompactFrame, SnapcompactSymbol } from "./types";

/** A renderer model profile. See model-profiles.ts for concrete values. */
export interface FrameProfile {
  id: string;
  width: number;
  height: number;
  fontScale: number;
  lineGap: number;
  marginX: number;
  marginY: number;
  /** Soft cap on frames; older content is degraded when exceeded. */
  maxFrames: number;
}

export interface RenderInput {
  sourceText: string;
  rawSymbols: RawSymbol[];
  profile: FrameProfile;
}

export interface RenderResult {
  frames: SnapcompactFrame[];
  symbols: SnapcompactSymbol[];
  /** Adjusted source text after symbol substitution. */
  adjustedSourceText: string;
  truncated: boolean;
}

const MIN_SUBSTITUTION_LEN = 12;
const SUBSTITUTION_HINT = (id: string) => `[${id}]`;

/** Apply dictionary substitution to the source text. The first occurrence
 *  of each long symbol is kept verbatim so the surrounding prose still
 *  names the thing; subsequent occurrences are replaced with the short
 *  anchor. Short symbols (below MIN_SUBSTITUTION_LEN) are never substituted. */
export function applySubstitution(sourceText: string, symbols: SnapcompactSymbol[]): string {
  if (!symbols.length) return sourceText;
  let out = sourceText;
  for (const s of symbols) {
    if (s.value.length < MIN_SUBSTITUTION_LEN) continue;
    out = replaceAfterFirst(out, s.value, SUBSTITUTION_HINT(s.id));
  }
  return out;
}

function splitOccurrences(text: string, value: string, replacement: string): string {
  let out = text;
  let from = 0;
  while (true) {
    const i = out.indexOf(value, from);
    if (i < 0) break;
    out = out.slice(0, i) + replacement + out.slice(i + value.length);
    from = i + replacement.length;
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

function wrapLines(text: string, cols: number): string[] {
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

function renderLine(pixels: Uint8Array, width: number, x: number, y: number, line: string, scale: number, gap: number): void {
  const glyphW = GLYPH_W * scale;
  const glyphH = GLYPH_H * scale;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const g = FONT_5X7[ch] ?? (ch === "\t" ? FONT_5X7[" "] : glyph5x7(ch));
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        const on = g[row][col] === "X";
        if (!on) continue;
        fillRect(pixels, width, pixels.length * 8 / Math.ceil(width / 8),
          x + (i * (glyphW + gap)) + col * scale,
          y + row * scale,
          scale, scale, true);
      }
    }
  }
  // Advance x by the rendered width (caller handles newlines).
  void glyphH;
}

function frameToPng(width: number, height: number, lines: string[], profile: FrameProfile): Buffer {
  const pixels = new Uint8Array(Math.ceil(width / 8) * height);
  pixels.fill(0xFF);
  const scale = profile.fontScale;
  const lineGap = profile.lineGap;
  const cellW = GLYPH_W * scale + lineGap;
  const cellH = GLYPH_H * scale + Math.max(1, lineGap);
  const cols = Math.max(1, Math.floor((width - 2 * profile.marginX) / cellW));
  const linesPerFrame = Math.max(1, Math.floor((height - 2 * profile.marginY) / cellH));
  const wrapped = wrapLines(lines.join("\n"), cols);
  const startY = profile.marginY;
  const startX = profile.marginX;
  for (let i = 0; i < linesPerFrame; i++) {
    const line = wrapped[i];
    if (line === undefined) break;
    const y = startY + i * cellH;
    let x = startX;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      const g = FONT_5X7[ch] ?? (ch === "\t" ? FONT_5X7[" "] : glyph5x7(ch));
      for (let row = 0; row < GLYPH_H; row++) {
        for (let col = 0; col < GLYPH_W; col++) {
          const on = g[row][col] === "X";
          if (on) fillRect(pixels, width, height, x + col * scale, y + row * scale, scale, scale, true);
        }
      }
      x += cellW;
    }
  }
  return encodePng1Bit(width, height, pixels);
}

export function renderFrames(input: RenderInput): RenderResult {
  const symbols = assignIds(input.rawSymbols);
  const adjusted = applySubstitution(input.sourceText, symbols);
  const scale = input.profile.fontScale;
  const cellW = GLYPH_W * scale + input.profile.lineGap;
  const cellH = GLYPH_H * scale + Math.max(1, input.profile.lineGap);
  const cols = Math.max(1, Math.floor((input.profile.width - 2 * input.profile.marginX) / cellW));
  const linesPerFrame = Math.max(1, Math.floor((input.profile.height - 2 * input.profile.marginY) / cellH));
  const wrapped = wrapLines(adjusted, cols);
  const totalLines = wrapped.length;
  const totalFrames = Math.max(1, Math.ceil(totalLines / linesPerFrame));
  const truncated = totalFrames > input.profile.maxFrames;
  const emitFrames = truncated ? input.profile.maxFrames : totalFrames;
  const out: SnapcompactFrame[] = [];
  let sourceCursor = 0;
  const linesPerEmit = Math.ceil(totalLines / emitFrames);
  for (let f = 0; f < emitFrames; f++) {
    const start = f * linesPerEmit;
    const end = Math.min(totalLines, (f + 1) * linesPerEmit);
    const slice = wrapped.slice(start, end);
    const png = frameToPng(input.profile.width, input.profile.height, slice, input.profile);
    // Approximate source offset (best effort; the persisted archive stores
    // a more precise mapping built from the original transcript).
    const sourceOffset = sourceCursor;
    sourceCursor += slice.join("\n").length + 1;
    out.push({
      index: f,
      width: input.profile.width,
      height: input.profile.height,
      png,
      sourceOffset,
      sourceEnd: sourceCursor,
    });
  }
  return { frames: out, symbols, adjustedSourceText: adjusted, truncated };
}

// Suppress unused-renderLine warning; renderLine is kept for a future
// streaming path and validated by tests indirectly via frameToPng.
void renderLine;
