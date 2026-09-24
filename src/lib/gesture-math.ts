/**
 * Pointer-gesture math (apple-design §§5, 6, 9). Pure functions so the physics
 * stays testable and the resizers stay thin. Units are px and px/s unless
 * noted; all helpers are total (no React, no DOM).
 */

/**
 * Apple's momentum projection (Designing Fluid Interfaces sample code):
 * where a flick is *going*, so a release can snap to the target nearest the
 * projected endpoint rather than the release point. Exponential-decay form,
 * not the physics-textbook v²/(2·decel).
 */
export function projectMomentum(initialVelocityPxPerSec: number, decelerationRate = 0.998): number {
  return ((initialVelocityPxPerSec / 1000) * decelerationRate) / (1 - decelerationRate);
}

/**
 * Progressive boundary resistance: the further past the bound, the less the
 * value follows. Returns the resistive offset to ADD to the bound (signed
 * like `overshoot`). `dimension` scales the curve (pass the relevant panel
 * width); `constant` tunes softness (0.55 ≈ Apple sample feel).
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (overshoot === 0 || dimension <= 0) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * Clamp with soft boundaries: inside [min, max] the value passes through
 * untouched (1:1 tracking); outside, resistance grows progressively instead
 * of hard-stopping. Release logic snaps back to the hard bound.
 */
export function clampWithRubberband(value: number, min: number, max: number, dimension: number): number {
  if (value < min) return min + rubberband(value - min, dimension);
  if (value > max) return max + rubberband(value - max, dimension);
  return value;
}

/** Hard clamp for gesture release (snap back after rubber-band overshoot). */
export function clampHard(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Release velocity from a short pointermove history (newest last). Uses the
 * last two samples spanning at least 1ms; returns 0 when there is no usable
 * movement. Callers hand this to a spring as its initial velocity so the
 * drag→animation seam is invisible.
 */
export function releaseVelocity(history: Array<{ x: number; t: number }>): number {
  if (history.length < 2) return 0;
  const last = history[history.length - 1]!;
  const prev = history[history.length - 2]!;
  const dt = (last.t - prev.t) / 1000;
  if (dt <= 0) return 0;
  return (last.x - prev.x) / dt;
}
