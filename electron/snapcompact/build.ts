// Build a snapcompact archive from a projected message window.
//
// Deterministic, no LLM. Pure: takes the input, returns the archive
// (frames included as raw PNG bytes). Persistence is the caller's job.

import { serializeTranscript } from "./serializer";
import { extractHighValueTokens } from "./symbol-dictionary";
import { renderFrames } from "./renderer";
import { profileToFrameProfile, type SnapcompactModelProfile } from "./model-profiles";
import type { SnapcompactArchive } from "./types";

export interface BuildArchiveInput {
  sessionId: string;
  sessionFile: string;
  messages: any[];
  profile: SnapcompactModelProfile;
  /** Optional last message entryId for the coveredThrough anchor. */
  coveredThroughMessageId?: string | null;
  /** Optional last activity timestamp (ms). */
  coveredThroughTimestamp?: number | null;
  /** Optional per-tool-result and total budget overrides. */
  perToolResultBudget?: number;
  totalBudget?: number;
}

export interface BuildArchiveResult {
  archive: SnapcompactArchive;
  sourceText: string;
  truncated: boolean;
  renderMs: number;
  serializeMs: number;
  frameBytes: number;
  symbolCount: number;
}

export function buildArchive(input: BuildArchiveInput): BuildArchiveResult {
  const t0 = performance.now();
  const serialized = serializeTranscript({
    messages: input.messages,
    perToolResultBudget: input.perToolResultBudget,
    totalBudget: input.totalBudget,
  });
  const t1 = performance.now();
  const rawSymbols = extractHighValueTokens(serialized.sourceText);
  const frameProfile = profileToFrameProfile(input.profile);
  const rendered = renderFrames({
    sourceText: serialized.sourceText,
    rawSymbols,
    profile: frameProfile,
  });
  const t2 = performance.now();
  const frameBytes = rendered.frames.reduce((n, f) => n + f.png.length, 0);
  const archive: SnapcompactArchive = {
    version: 1,
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    strategy: "snapcompact",
    sourceText: serialized.sourceText,
    symbols: rendered.symbols,
    frames: rendered.frames,
    coveredThroughMessageId: input.coveredThroughMessageId ?? null,
    createdAt: Date.now(),
    coveredThroughTimestamp: input.coveredThroughTimestamp ?? null,
    frameWidth: input.profile.width,
    frameHeight: input.profile.height,
    profileId: input.profile.id,
    frameBytes,
  };
  return {
    archive,
    sourceText: serialized.sourceText,
    truncated: serialized.truncated || rendered.truncated,
    serializeMs: t1 - t0,
    renderMs: t2 - t1,
    frameBytes,
    symbolCount: rendered.symbols.length,
  };
}
