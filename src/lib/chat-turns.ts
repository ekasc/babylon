import type { ChatItem } from "../store";
import type { TurnFold } from "./chat-folds";

/** Flat entry: single item or a grouped tool run. Mirrors the ChatView
 *  entry model (turn windows slice these, never rebuild them). */
export type TurnEntry =
  | { type: "single"; item: ChatItem; index: number }
  | { type: "group"; tools: Array<Extract<ChatItem, { kind: "tool" }>>; index: number };

/** One user turn (or the leading prologue): the unit of virtualization. */
export interface TurnViewModel {
  /** Stable within a session: fold turnId, or the user item id, or "__prologue". */
  id: string;
  /** Inclusive item index of the turn's first row. */
  start: number;
  /** Exclusive item index (next turn's start, or item count). */
  end: number;
  /** Entries (singles + tool groups) whose item index falls in [start, end). */
  entries: TurnEntry[];
  /** Settled and folded by the user (hidden rows stay unmounted). */
  collapsed: boolean;
  /** Actively streaming: always mounted regardless of viewport. */
  live: boolean;
}

/** Fallback height (px) for a turn never measured in this session. */
export const TURN_FALLBACK_HEIGHT = 320;
/** Turns kept mounted above and below the visible band. */
export const TURN_OVERSCAN = 4;
/** Session measurement maps retained (LRU-ish: oldest session drops). */
export const MAX_MEASURED_SESSIONS = 12;

/** Session-scoped measured turn heights: sessionKey -> turnId -> px. */
export type TurnMeasurements = Map<string, Map<string, number>>;

/**
 * Build one view model per turn from fold structure. Spans come from user
 * boundaries: items before the first user row form a "__prologue" turn so
 * system/recap headers participate in windowing like everything else.
 * Unfoldable spans (no assistant yet) still form turns — collapsed=false,
 * entries fully visible. Entry bucketing is a single pass (entries arrive
 * sorted by item index, as built).
 */
export function buildTurnViewModels(args: {
  entries: TurnEntry[];
  itemCount: number;
  userIndices: number[];
  userIdAt: (start: number) => string | null;
  foldAt: (start: number) => TurnFold | undefined;
  liveTurnId: string | null;
  isCollapsed: (turnId: string) => boolean;
  streaming: boolean;
}): TurnViewModel[] {
  const { entries, itemCount, userIndices, userIdAt, foldAt, liveTurnId, isCollapsed, streaming } = args;
  const starts = userIndices.filter((s) => s >= 0 && s < itemCount);
  const bounds: Array<{ id: string; start: number; end: number; collapsed: boolean; live: boolean }> = [];
  if (starts.length === 0 || (starts[0] ?? 0) > 0) {
    bounds.push({ id: "__prologue", start: 0, end: starts[0] ?? itemCount, collapsed: false, live: false });
  }
  for (let t = 0; t < starts.length; t++) {
    const start = starts[t]!;
    const end = t + 1 < starts.length ? starts[t + 1]! : itemCount;
    const fold = foldAt(start);
    const id = fold?.turnId ?? userIdAt(start) ?? `turn-${start}`;
    const live = streaming && t === starts.length - 1 ? true : id === liveTurnId;
    bounds.push({ id, start, end, collapsed: fold ? isCollapsed(id) : false, live });
  }
  // Bucket entries into spans in one pass (both sorted by item index).
  const buckets: TurnEntry[][] = bounds.map(() => []);
  let b = 0;
  const sorted = [...entries].sort((x, y) => x.index - y.index);
  for (const entry of sorted) {
    while (b + 1 < bounds.length && entry.index >= bounds[b + 1]!.start) b++;
    if (entry.index >= bounds[b]!.start && entry.index < bounds[b]!.end) {
      buckets[b]!.push(entry);
    }
  }
  return bounds.map((span, i) => ({ ...span, entries: buckets[i]! }));
}

/** Prefix-sum layout over per-turn heights (measured or fallback). */
export function layoutTurns(
  heights: Array<number | undefined>,
  fallback: number = TURN_FALLBACK_HEIGHT
): { offsets: number[]; total: number } {
  const offsets: number[] = new Array(heights.length);
  let top = 0;
  for (let i = 0; i < heights.length; i++) {
    offsets[i] = top;
    top += heights[i] ?? fallback;
  }
  return { offsets, total: top };
}

/** OffsetTop of one turn without laying out the whole list. */
export function estimateTurnOffset(
  index: number,
  heights: Array<number | undefined>,
  fallback: number = TURN_FALLBACK_HEIGHT
): number {
  let top = 0;
  for (let i = 0; i < index; i++) top += heights[i] ?? fallback;
  return top;
}

export interface TurnWindow {
  /** Inclusive first mounted turn. */
  start: number;
  /** Exclusive end of the contiguous mounted band. */
  end: number;
  /** Pinned turn indices outside [start, end), ascending. */
  extra: number[];
}

/**
 * Visible turn band for a scroll position, plus pinned turns (live turn,
 * find target) that mount as separate islands. Binary-searches turn ends
 * so the range computation itself is O(log n).
 */
export function resolveVisibleTurnRange(args: {
  turnCount: number;
  scrollTop: number;
  viewportHeight: number;
  offsets: number[];
  heights: Array<number | undefined>;
  fallback?: number;
  overscanTurns?: number;
  pinned?: number[];
}): TurnWindow {
  const { turnCount, scrollTop, viewportHeight, offsets, heights } = args;
  const fallback = args.fallback ?? TURN_FALLBACK_HEIGHT;
  const overscan = args.overscanTurns ?? TURN_OVERSCAN;
  if (turnCount <= 0) return { start: 0, end: 0, extra: [] };
  const endOf = (i: number): number => (offsets[i] ?? 0) + (heights[i] ?? fallback);
  // First turn whose bottom edge passes the viewport top.
  let lo = 0;
  let hi = turnCount;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (endOf(mid) > scrollTop) hi = mid;
    else lo = mid + 1;
  }
  const first = Math.min(lo, turnCount - 1);
  // Last turn whose top edge precedes the viewport bottom.
  const bottom = scrollTop + Math.max(viewportHeight, 0);
  lo = first;
  hi = turnCount;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid] ?? 0) < bottom) lo = mid + 1;
    else hi = mid;
  }
  const last = Math.max(first, lo - 1);
  const start = Math.max(0, first - overscan);
  const end = Math.min(turnCount, last + 1 + overscan);
  const extra = [...new Set(args.pinned ?? [])]
    .filter((t) => Number.isInteger(t) && t >= 0 && t < turnCount && (t < start || t >= end))
    .sort((a, b) => a - b);
  return { start, end, extra };
}

/** Group mounted turn indices into contiguous [start, end) runs for spacer math. */
export function groupContiguousRuns(indices: number[]): Array<{ start: number; end: number }> {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const runs: Array<{ start: number; end: number }> = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last && i === last.end) last.end = i + 1;
    else runs.push({ start: i, end: i + 1 });
  }
  return runs;
}

/**
 * Scroll adjustment when a mounted turn's measured height changes. Only a
 * turn entirely above the viewport moves the anchor (its growth/shrinkage
 * shifts everything below); a turn at or below the viewport top never
 * disturbs content the user is looking at.
 */
export function compensateMeasuredHeight(args: {
  scrollTop: number;
  turnOffsetTop: number;
  oldHeight: number;
  newHeight: number;
}): number {
  const { scrollTop, turnOffsetTop, oldHeight, newHeight } = args;
  if (turnOffsetTop + oldHeight <= scrollTop) {
    return Math.max(0, scrollTop + (newHeight - oldHeight));
  }
  return scrollTop;
}

/**
 * Fold one fresh turn measurement into scroll state. The old height MUST be
 * the height the current layout actually used (the laid-out value, estimate
 * included) — never recomputed from the cache after inserting the new
 * value, which would compare the measurement against itself and drop the
 * anchor correction for turns above the viewport.
 */
export function applyMeasuredHeight(args: {
  scrollTop: number;
  turnOffsetTop: number;
  laidOutHeight: number | undefined;
  measuredHeight: number;
  fallback?: number;
}): { scrollTop: number; store: boolean } {
  const oldH = args.laidOutHeight ?? args.fallback ?? TURN_FALLBACK_HEIGHT;
  if (Math.abs(oldH - args.measuredHeight) <= 0.5) return { scrollTop: args.scrollTop, store: false };
  return {
    scrollTop: compensateMeasuredHeight({
      scrollTop: args.scrollTop,
      turnOffsetTop: args.turnOffsetTop,
      oldHeight: oldH,
      newHeight: args.measuredHeight,
    }),
    store: true,
  };
}

/** True when a column width change materially alters line wrapping (first
 *  observation only establishes the baseline). */
export function widthInvalidatesCache(args: {
  prevWidth: number | null;
  nextWidth: number;
  threshold?: number;
}): boolean {
  if (args.prevWidth == null) return false;
  return Math.abs(args.nextWidth - args.prevWidth) > (args.threshold ?? 8);
}

/**
 * Prepend anchor math: after older turns arrive above, shift scrollTop by
 * the added height above the anchor turn so the same content stays under
 * the viewport. Added heights use measured values where known, estimates
 * elsewhere (same basis as the spacers, so the correction is exact
 * relative to what is on screen).
 */
export function prependScrollCorrection(args: {
  prevScrollTop: number;
  prevAnchorOffsetTop: number;
  nextAnchorOffsetTop: number;
}): number {
  const { prevScrollTop, prevAnchorOffsetTop, nextAnchorOffsetTop } = args;
  return Math.max(0, prevScrollTop + (nextAnchorOffsetTop - prevAnchorOffsetTop));
}

/** Turn index containing an item index (turn starts ascending). Falls back
 *  to the nearest valid turn for out-of-range input. */
export function findTurnIndexForItem(turns: TurnViewModel[], itemIndex: number): number {
  if (turns.length === 0) return -1;
  let lo = 0;
  let hi = turns.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((turns[mid]?.start ?? 0) > itemIndex) hi = mid;
    else lo = mid + 1;
  }
  const candidate = Math.max(0, lo - 1);
  const turn = turns[candidate];
  if (turn && itemIndex < turn.end) return candidate;
  return turns.length - 1;
}

export function getMeasuredHeight(
  cache: TurnMeasurements,
  sessionKey: string | null,
  turnId: string
): number | undefined {
  if (sessionKey == null) return undefined;
  return cache.get(sessionKey)?.get(turnId);
}

export function setMeasuredHeight(
  cache: TurnMeasurements,
  sessionKey: string | null,
  turnId: string,
  height: number,
  maxSessions: number = MAX_MEASURED_SESSIONS
): void {
  if (sessionKey == null) return;
  let session = cache.get(sessionKey);
  if (!session) {
    session = new Map();
    cache.set(sessionKey, session);
    while (cache.size > maxSessions) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }
  session.set(turnId, height);
}

/** Session mean of measured heights, else the fallback. Estimates improve
 *  as turns mount; unseen turns never block on measurement. */
export function estimateTurnHeight(
  cache: TurnMeasurements,
  sessionKey: string | null,
  fallback: number = TURN_FALLBACK_HEIGHT
): number {
  const session = sessionKey != null ? cache.get(sessionKey) : undefined;
  if (!session || session.size === 0) return fallback;
  let sum = 0;
  for (const h of session.values()) sum += h;
  return sum / session.size;
}
