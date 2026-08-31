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
  /** When set, the previous cumulative archive's normalized source. The new
   *  archive will be built from previousSourceText + new messages' source,
   *  re-extracting and re-rendering fresh (no OCR). */
  previousArchive?: SnapcompactArchive | null;
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
  let joined = out.map((s) => s.value).join("|");
  while (out.length > 0 && joined.length > maxDictChars) {
    // Hard cap: even a single oversized symbol must not survive.
    // Discard the longest value first so the dictionary stays within
    // budget. If the last symbol alone exceeds, drop it — the budget
    // is a hard limit, not advisory.
    if (out.length === 1) {
      // Single symbol exceeds maxDictChars — discard it entirely
      // rather than violating the cap. The source text still contains
      // the raw value verbatim on first occurrence.
      out = [];
      break;
    }
    out.pop();
    joined = out.map((s) => s.value).join("|");
  }
  return out;
}

export function buildArchive(input: BuildArchiveInput): BuildArchiveResult {
  const profile = input.profile;
  const t0 = performance.now();
  const serializedNew = serializeTranscript({
    messages: input.messages,
    totalBudget: profile.maxSourceChars,
  });
  // Cumulative rollover: if a previous snapcompact generation exists on
  // this branch, rebuild from its normalized source + the newly discarded
  // messages. This preserves history without OCRing PNGs.
  let combinedSource = serializedNew.sourceText;
  let truncated = serializedNew.truncated;
  let keptCount = serializedNew.keptCount;
  let firstKept = serializedNew.firstKeptEntryId;
  let lastKept = serializedNew.lastKeptEntryId;
  let omitted: import("./serializer").OmittedEntry[] = [...serializedNew.omittedTrailing] as import("./serializer").OmittedEntry[];
  if (input.previousArchive?.sourceText) {
    const prev = input.previousArchive.sourceText;
    const sep = prev && combinedSource ? "\n\n" : "";
    combinedSource = prev + sep + combinedSource;
    // Enforce total budget on the combined source keeping recent suffix
    if (combinedSource.length > profile.maxSourceChars) {
      const dropped = combinedSource.length - profile.maxSourceChars;
      combinedSource = combinedSource.slice(-profile.maxSourceChars);
      // Record that oldest content was evicted due to cumulative budget
      truncated = true;
      omitted.push({ entryId: input.previousArchive.firstKeptEntryId ?? "prev", role: "cumulative", reason: "total-budget" as const });
      void dropped;
    }
    // Coverage spans the cumulative archive
    firstKept = input.previousArchive.firstKeptEntryId ?? firstKept;
    // lastKept stays as newest
    keptCount = (input.previousArchive.keptCount ?? 0) + keptCount;
    omitted = [...((input.previousArchive.omittedTrailing as any) ?? []), ...omitted] as any;
  }
  const t1 = performance.now();
  const rawSymbols = extractHighValueTokens(combinedSource);
  const capped = capRawSymbols(rawSymbols, profile.maxSymbolCount, profile.maxDictChars);
  const frameProfile = profileToFrameProfile(profile);
  const rendered = renderFrames({ sourceText: combinedSource, rawSymbols: capped, profile: frameProfile });
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
  const textFallback = buildTextFallback(combinedSource, rendered.symbols, rendered.adjustedSourceText);
  const archive: SnapcompactArchive = {
    version: 1,
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    strategy: "snapcompact",
    sourceText: combinedSource,
    symbols: rendered.symbols,
    frames: rendered.frames,
    coveredThroughMessageId: lastKept,
    createdAt: Date.now(),
    coveredThroughTimestamp: input.coveredThroughTimestamp ?? null,
    frameWidth: profile.width,
    frameHeight: profile.height,
    profileId: profile.id,
    frameBytes,
    compactionGenerationId: randomUUID(),
    firstKeptEntryId: firstKept,
    lastKeptEntryId: lastKept,
    keptCount,
    omittedTrailing: omitted,
    textFallback,
  };
  return {
    archive,
    sourceText: combinedSource,
    truncated,
    renderMs: t2 - t1,
    serializeMs: t1 - t0,
    frameBytes,
    symbolCount: rendered.symbols.length,
  };
}

function buildTextFallback(sourceText: string, symbols: import("./types").SnapcompactSymbol[], adjusted: string): string {
  const dict = symbols.length ? symbols.map((s) => `${s.id}=${s.value}`).join("\n") : "(no symbols)";
  const head = adjusted.length > 1200 ? adjusted.slice(0, 1200) : adjusted;
  const tail = adjusted.length > 1200 ? adjusted.slice(Math.max(0, adjusted.length - 1200)) : "";
  return [
    "[Snapcompact text fallback]",
    "--- archive head ---",
    head,
    "--- archive tail ---",
    tail || "(empty)",
    "--- exact-token dictionary ---",
    dict,
    "--- end snapcompact ---",
  ].join("\n");
}

export function imageTokenEstimateFor(archive: SnapcompactArchive, profile: SnapcompactModelProfile): number {
  return archive.frames.length * profile.imageTokenEstimate;
}
