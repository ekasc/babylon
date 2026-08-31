// Explicit frame planning for the snapcompact renderer.
//
// Given a chunk of source text, a profile, and a substitution-adjusted
// version, produce a deterministic frame plan where every line is either
// assigned to exactly one frame OR recorded as omitted. No silent holes.
//
// The planner is structured to support foveation (HQ at boundaries, LQ
// in the middle) via per-frame `density` and `linesPerFrame`; in this
// commit every frame uses the same density. The foveation policy is the
// obvious follow-up: it can change `linesPerFrame` per frame without
// touching the planner's line-assignment contract.

import { wrapLines } from "./renderer";
import type { FrameProfile } from "./renderer";

export interface FramePlanEntry {
  index: number;
  /** First line index in the wrapped-text array (inclusive). */
  lineStart: number;
  /** Last line index in the wrapped-text array (inclusive). */
  lineEnd: number;
  width: number;
  height: number;
  /** True iff this frame contains an explicit "lines omitted" marker. */
  carriesOmission: boolean;
  density: "hq" | "lq";
}

export interface FramePlan {
  entries: FramePlanEntry[];
  totalLines: number;
  wrappedLines: string[];
  linesAssigned: number;
  /** Lines that did not fit in any frame, with the source marker used. */
  omitted: { lineRange: [number, number]; marker: string };
  linesPerFrame: number;
}

const OMISSION_MARKER = "[…snapcompact omitted lines…]";

/**
 * Build a frame plan. The plan assigns whole lines to frames in
 * chronological order. If the archive has more lines than the frame
 * capacity allows, the surplus is reserved in `omitted` and a single
 * frame (`carriesOmission: true`) records the omission marker so the
 * frame PNG contains an honest note rather than silently dropping
 * content. No rendered frame is allowed to contain silent holes.
 */
export function planFrames(
  sourceText: string,
  profile: FrameProfile,
): FramePlan {
  const scale = profile.fontScale;
  const cellW = 5 * scale + profile.lineGap;
  const cellH = 7 * scale + Math.max(1, profile.lineGap);
  const cols = Math.max(1, Math.floor((profile.width - 2 * profile.marginX) / cellW));
  const wrapped = wrapLines(sourceText, cols);
  const totalLines = wrapped.length;

  const linesPerFrame = Math.max(
    1,
    Math.floor((profile.height - 2 * profile.marginY) / cellH),
  );
  const capacity = linesPerFrame * profile.maxFrames;

  let linesAssigned: number;
  let omitted: FramePlan["omitted"];
  let bodyLines: string[];

  if (totalLines <= capacity) {
    linesAssigned = totalLines;
    omitted = { lineRange: [-1, -1], marker: "" };
    bodyLines = wrapped;
  } else {
    // Reserve one frame for the omission marker. The remaining
    // (maxFrames - 1) frames carry as much body as they fit.
    const bodyCapacity = Math.max(0, (profile.maxFrames - 1) * linesPerFrame);
    const keep = Math.min(bodyCapacity, totalLines);
    linesAssigned = keep;
    bodyLines = wrapped.slice(0, keep);
    omitted = {
      lineRange: [keep, totalLines - 1],
      marker: `${OMISSION_MARKER} lines=${totalLines - keep} kept=${keep}/${totalLines}`,
    };
  }

  const entries: FramePlanEntry[] = [];
  let cursor = 0;
  let frameIdx = 0;
  while (cursor < bodyLines.length && frameIdx < profile.maxFrames) {
    const end = Math.min(cursor + linesPerFrame, bodyLines.length);
    entries.push({
      index: frameIdx,
      lineStart: cursor,
      lineEnd: end - 1,
      width: profile.width,
      height: profile.height,
      carriesOmission: false,
      density: "hq",
    });
    cursor = end;
    frameIdx += 1;
  }
  if (omitted.marker) {
    entries.push({
      index: frameIdx,
      lineStart: omitted.lineRange[0],
      lineEnd: omitted.lineRange[1],
      width: profile.width,
      height: profile.height,
      carriesOmission: true,
      density: "hq",
    });
  }

  return {
    entries,
    totalLines,
    wrappedLines: wrapped,
    linesAssigned,
    omitted,
    linesPerFrame,
  };
}
