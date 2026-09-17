// Derived session telemetry for the floating stats card. Everything here is
// pure: the Pi SDK's SessionStats supplies tokens/messages, the transcript
// supplies compaction boundaries, and TPS comes from measured turn timing.

export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

export interface TurnSample {
  outputTokens: number;
  ms: number;
}

/**
 * Fraction of prompt tokens served from cache: cacheRead ÷ (cacheRead + input + cacheWrite).
 * Null when no prompt tokens are accounted for yet.
 */
export function cacheHitRate(tokens?: TokenUsage | null): number | null {
  const read = tokens?.cacheRead ?? 0;
  const fresh = tokens?.input ?? 0;
  const total = read + fresh + (tokens?.cacheWrite ?? 0);
  if (!(total > 0)) return null;
  return Math.min(1, read / total);
}

/**
 * Completed compactions in the loaded transcript. Handoff boundaries are
 * installements of an existing summary, not a compaction of this session, so
 * they are excluded. Aborted and in-flight compactions never count.
 */
export function countCompactions(
  items: ReadonlyArray<{ kind?: string; status?: string; reason?: string }>
): number {
  let n = 0;
  for (const item of items) {
    if (item?.kind !== "compaction" || item.status !== "compacted") continue;
    if (typeof item.reason === "string" && item.reason.startsWith("handoff")) continue;
    n++;
  }
  return n;
}

/** Append a turn sample, dropping non-measurements and keeping the newest `max`. */
export function pushTurnSample(
  samples: readonly TurnSample[],
  sample: TurnSample,
  max = 24
): TurnSample[] {
  if (!(sample.outputTokens > 0) || !(sample.ms > 0)) return [...samples];
  return [...samples, sample].slice(-max);
}

/** Output tokens per second across samples: total produced ÷ total time. */
export function effectiveTps(samples: readonly TurnSample[]): number | null {
  let output = 0;
  let ms = 0;
  for (const sample of samples) {
    output += sample.outputTokens;
    ms += sample.ms;
  }
  if (!(output > 0) || !(ms > 0)) return null;
  return output / (ms / 1000);
}
