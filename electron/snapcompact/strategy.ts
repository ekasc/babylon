// Single-owner strategy selection for snapcompact.
//
// The reviewer's invariant: "one owner responsible for deciding" which
// strategy to use. This module is that owner. Callers ask
// `pickStrategy({ ... })` and receive either "snapcompact" or "summary".
// No other module reads settings, model capabilities, or archive
// availability to make this decision.

import { modelSupportsImages } from "./model-profiles";
import type { SnapcompactArchive } from "./types";
import type { CompactionMode, CompactionStrategy } from "./types";

export interface PickStrategyInput {
  /** The active model object (from Babylon's runtime facade). */
  model: { provider?: string; id?: string; input?: string[] } | null | undefined;
  /** The user-selected compaction mode. */
  mode: CompactionMode;
  /** The current archive, if any. */
  archive: SnapcompactArchive | null;
  /** True when the integration can actually produce an archive right now. */
  archiveProducible: boolean;
  /** True when an archive is already loaded and the session is the same. */
  archiveMatchesSession: boolean;
}

export interface PickStrategyResult {
  strategy: CompactionStrategy;
  /** Human-readable reason for logs and diagnostics. Never logged with content. */
  reason: string;
}

const FALLBACK_REASONS = {
  AUTOMATIC: "automatic",
  MODE_DISABLED: "mode is not snapcompact",
  NO_MODEL: "no active model",
  MODEL_VISIONLESS: "active model does not support image input",
  ARCHIVE_NOT_PRODUCIBLE: "snapcompact archive cannot be produced safely",
  ARCHIVE_MISSING: "no current snapcompact archive for this session",
  ARCHIVE_SESSION_MISMATCH: "existing archive is for a different session",
} as const;

export function pickStrategy(input: PickStrategyInput): PickStrategyResult {
  if (input.mode === "summary") return { strategy: "summary", reason: FALLBACK_REASONS.MODE_DISABLED };
  if (input.mode === "automatic") {
    if (!input.model) return { strategy: "summary", reason: FALLBACK_REASONS.NO_MODEL };
    if (!modelSupportsImages(input.model)) return { strategy: "summary", reason: FALLBACK_REASONS.MODEL_VISIONLESS };
    if (!input.archiveProducible) return { strategy: "summary", reason: FALLBACK_REASONS.ARCHIVE_NOT_PRODUCIBLE };
    if (!input.archive) return { strategy: "summary", reason: FALLBACK_REASONS.ARCHIVE_MISSING };
    if (!input.archiveMatchesSession) return { strategy: "summary", reason: FALLBACK_REASONS.ARCHIVE_SESSION_MISMATCH };
    return { strategy: "snapcompact", reason: FALLBACK_REASONS.AUTOMATIC };
  }
  return { strategy: "summary", reason: FALLBACK_REASONS.MODE_DISABLED };
}
