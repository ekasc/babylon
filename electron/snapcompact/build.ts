// Build a snapcompact archive from a projected message window.
//
// Pure: takes the input, returns a `BuildResult` with the archive and
// budget / timing diagnostics. The build enforces the profile's
// budgets (frame count, frame bytes, image tokens, source chars,
// symbol count, dictionary chars) and throws `ArchiveBudgetError`
// if any budget is exceeded. Persistence is the caller's job.

import { randomUUID } from "node:crypto";
import { serializeTranscript } from "./serializer";
import { extractHighValueTokens, type RawSymbol } from "./symbol-dictionary";
import { renderFrames } from "./renderer";
import { profileToFrameProfile, type SnapcompactModelProfile } from "./model-profiles";
import type { SnapcompactArchive, SnapcompactSymbol } from "./types";

export class ArchiveBudgetError extends Error {
  readonly budget: string;
  readonly observed: number;
  readonly limit: number;
  constructor(budget: string, observed: number, limit: number) {
    super(`snapcompact budget exceeded: ${budget} observed=${observed} limit=${limit}`);
    this.name = "ArchiveBudgetError";
    this.budget = budget;
    this.observed = observed;
    this.limit = limit;
  }
}

export interface BuildArchiveInput {
  sessionId: string;
  sessionFile: string;
  messages: any[];
  profile: SnapcompactModelProfile;
  /** Optional last message entryId for the coveredThrough anchor. */
  coveredThroughMessageId?: string | null;
  /** Optional last activity timestamp (ms). */
  coveredThroughTimestamp?: number | null;
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

function capRawSymbols(symbols: RawSymbol[], maxCount: number, maxDictChars: number): RawSymbol[] {
  let out = symbols.length > maxCount ? symbols.slice(0, maxCount) : symbols.slice();
  // Enforce maxDictChars regardless of count — a few very long values can
  // still exceed the budget even when count is under maxCount.
  let joined = out.map((s) => s.value).join("|");
  while (out.length > 1 && joined.length > maxDictChars) {
    out.pop();
    joined = out.map((s) => s.value).join("|");
  }
  // Single remaining symbol that alone exceeds maxDictChars is kept as-is
  // (it was still extracted as high-value); caller may still enforce
  // tighter limits via symbol filtering if desired.
  return out;
}

export function buildArchive(input: BuildArchiveInput): BuildArchiveResult {
  const profile = input.profile;
  const t0 = performance.now();
  // Enforce the source budget via the serializer's totalBudget.
  const serialized = serializeTranscript({
    messages: input.messages,
    totalBudget: profile.maxSourceChars,
  });
  const t1 = performance.now();
  const rawSymbols = extractHighValueTokens(serialized.sourceText);
  const capped = capRawSymbols(rawSymbols, profile.maxSymbolCount, profile.maxDictChars);
  const frameProfile = profileToFrameProfile(profile);
  const rendered = renderFrames({ sourceText: serialized.sourceText, rawSymbols: capped, profile: frameProfile });
  const t2 = performance.now();
  // Enforce frame count and total PNG bytes.
  if (rendered.frames.length > profile.maxFrames) {
    throw new ArchiveBudgetError("maxFrames", rendered.frames.length, profile.maxFrames);
  }
  const frameBytes = rendered.frames.reduce((n, f) => n + f.png.length, 0);
  if (frameBytes > profile.maxArchiveBytes) {
    throw new ArchiveBudgetError("maxArchiveBytes", frameBytes, profile.maxArchiveBytes);
  }
  const imageTokens = rendered.frames.length * profile.imageTokenEstimate;
  if (imageTokens > profile.maxImageTokens) {
    throw new ArchiveBudgetError("maxImageTokens", imageTokens, profile.maxImageTokens);
  }
  const estimatedRequestBytes = Math.ceil((frameBytes * 4) / 3) + rendered.adjustedSourceText.length + rendered.symbols.reduce((n, s) => n + s.id.length + 1 + s.value.length + 1, 0);
  if (estimatedRequestBytes > profile.maxRequestBytes) {
    throw new ArchiveBudgetError("maxRequestBytes", estimatedRequestBytes, profile.maxRequestBytes);
  }
  const archive: SnapcompactArchive = {
    version: 1,
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    strategy: "snapcompact",
    sourceText: serialized.sourceText,
    symbols: rendered.symbols,
    frames: rendered.frames,
    coveredThroughMessageId: serialized.lastKeptEntryId,
    createdAt: Date.now(),
    coveredThroughTimestamp: input.coveredThroughTimestamp ?? null,
    frameWidth: profile.width,
    frameHeight: profile.height,
    profileId: profile.id,
    frameBytes,
    compactionGenerationId: randomUUID(),
    firstKeptEntryId: serialized.firstKeptEntryId,
    lastKeptEntryId: serialized.lastKeptEntryId,
    keptCount: serialized.keptCount,
    omittedTrailing: serialized.omittedTrailing,
  };
  return {
    archive,
    sourceText: serialized.sourceText,
    truncated: serialized.truncated,
    renderMs: t2 - t1,
    serializeMs: t1 - t0,
    frameBytes,
    symbolCount: rendered.symbols.length,
  };
}

export function imageTokenEstimateFor(archive: SnapcompactArchive, profile: SnapcompactModelProfile): number {
  return archive.frames.length * profile.imageTokenEstimate;
}
