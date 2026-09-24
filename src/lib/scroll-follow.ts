/**
 * Scroll-follow ownership for the transcript: only genuine user movement may
 * break the pinned-to-bottom follow. Scroll events also fire for layout
 * shifts (async highlight, markdown render), scroll anchoring, and smooth
 * programmatic landings — clearing follow on those strands the viewport
 * mid-stream and forces endless manual re-scrolling.
 *
 * Two signals mark genuine movement:
 * - a fresh input gesture (wheel, touch, scroll keys, pointer drag), or
 * - continuity with the previous scroll event (trackpad momentum and drags
 *   arrive as an unbroken stream; anchoring jumps land isolated after quiet).
 */

/** A scroll event may clear follow only when the user is really moving. */
export function shouldBreakFollow(input: {
  /** Fresh input gesture (wheel/touch/keys/drag) just happened. */
  gestured: boolean;
  /** This event continues an ongoing scroll stream (momentum/drag). */
  continuous: boolean;
}): boolean {
  return input.gestured || input.continuous;
}

/** True when an event extends the previous scroll sample without a pause. */
export function isContinuousScroll(
  prev: { at: number; top: number },
  now: number,
  top: number,
  gapMs = 150
): boolean {
  return now - prev.at < gapMs && Math.abs(top - prev.top) > 0;
}

/** Keys that scroll the transcript when the focus is not in a field. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", " ", "Home", "End"]);

export function isScrollKey(key: string): boolean {
  return SCROLL_KEYS.has(key);
}
