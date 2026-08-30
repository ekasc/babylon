// Model profiles and vision-capability detection for Snapcompact.
//
// Profiles are intentionally conservative and centralized. Adding a new
// provider means appending one entry to PROFILES below. No code in the
// rest of the pipeline needs to change.

import type { FrameProfile } from "./renderer";

/** A single model profile. Image token estimate is a rough upper bound
 *  used for budget assertions; it is NOT a precise provider number. */
export interface SnapcompactModelProfile {
  id: string;
  width: number;
  height: number;
  fontScale: number;
  lineGap: number;
  marginX: number;
  marginY: number;
  maxFrames: number;
  imageTokenEstimate: number;
  maxArchiveBytes: number;
}

/** Generic, OCR-friendly defaults. Works for any vision model. */
const GENERIC: SnapcompactModelProfile = {
  id: "generic-vision",
  width: 1024,
  height: 1024,
  fontScale: 2,
  lineGap: 2,
  marginX: 12,
  marginY: 12,
  maxFrames: 8,
  imageTokenEstimate: 765,
  maxArchiveBytes: 6 * 1024 * 1024,
};

/** OpenAI / GPT-4o / Codex family. */
const OPENAI: SnapcompactModelProfile = {
  id: "openai-gpt-4o",
  width: 1024,
  height: 1024,
  fontScale: 2,
  lineGap: 2,
  marginX: 12,
  marginY: 12,
  maxFrames: 8,
  imageTokenEstimate: 765,
  maxArchiveBytes: 6 * 1024 * 1024,
};

/** Anthropic / Claude family. */
const ANTHROPIC: SnapcompactModelProfile = {
  id: "anthropic-claude",
  width: 1024,
  height: 1024,
  fontScale: 2,
  lineGap: 2,
  marginX: 12,
  marginY: 12,
  maxFrames: 8,
  imageTokenEstimate: 1600,
  maxArchiveBytes: 5 * 1024 * 1024,
};

const PROFILES: readonly SnapcompactModelProfile[] = Object.freeze([GENERIC, OPENAI, ANTHROPIC]);

export const PROFILE_BY_ID: Readonly<Record<string, SnapcompactModelProfile>> = Object.freeze(
  Object.fromEntries(PROFILES.map((p) => [p.id, p]))
);

/** Heuristic prefix matching for providers Babylon already knows about. */
function classifyModel(model: { provider?: string; id?: string } | null | undefined): SnapcompactModelProfile {
  if (!model) return GENERIC;
  const id = String(model.id ?? "").toLowerCase();
  const provider = String(model.provider ?? "").toLowerCase();
  if (provider.includes("openai") || id.includes("gpt-4o") || id.includes("o4") || id.includes("codex")) return OPENAI;
  if (provider.includes("anthropic") || id.includes("claude")) return ANTHROPIC;
  return GENERIC;
}

export function profileForModel(model: { provider?: string; id?: string } | null | undefined): SnapcompactModelProfile {
  return classifyModel(model);
}

export function profileToFrameProfile(p: SnapcompactModelProfile): FrameProfile {
  return {
    id: p.id,
    width: p.width,
    height: p.height,
    fontScale: p.fontScale,
    lineGap: p.lineGap,
    marginX: p.marginX,
    marginY: p.marginY,
    maxFrames: p.maxFrames,
  };
}

/** Returns true if the model's advertised input modalities include image
 *  input. The authoritative source is the model registry that Babylon's
 *  runtime facade already exposes; this function takes a model object
 *  that mirrors that shape. */
export function modelSupportsImages(model: { input?: string[] } | null | undefined): boolean {
  if (!model) return false;
  const input = model.input;
  if (!Array.isArray(input)) return false;
  return input.includes("image");
}
