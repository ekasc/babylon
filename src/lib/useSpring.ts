// React bindings for the spring engine. Transforms are written imperatively to
// the DOM (no per-frame React re-renders), which is what keeps this fluid.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Spring, type SpringConfig, springModal } from "./spring";

/**
 * Drive an element's `translate3d(x)` with a spring. Returns a ref to attach
 * plus an imperative API for gestures: `set()` for 1:1 tracking, `retarget()`
 * for velocity-aware re-targeting.
 */
export function useFluidTransform<T extends HTMLElement = HTMLElement>(
  initialX: number,
  cfg?: SpringConfig,
  onSettled?: () => void
) {
  const ref = useRef<T | null>(null);
  const springRef = useRef<Spring | null>(null);
  const cfgRef = useRef(cfg ?? springModal);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const attach = useCallback(
    (el: T | null) => {
      if (!el) return;
      ref.current = el;
      el.style.willChange = "transform";
      const apply = (x: number) => {
        el.style.transform = `translate3d(${x}px,0,0)`;
      };
      springRef.current = new Spring(initialX, initialX, cfgRef.current, apply, () =>
        onSettledRef.current?.()
      );
      apply(initialX);
    },
    [initialX]
  );

  const api = useMemo(
    () => ({
      get spring() {
        return springRef.current;
      },
      set: (x: number) => springRef.current?.set(x),
      retarget: (target: number, velocity?: number, cfg?: SpringConfig) =>
        springRef.current?.retarget(target, velocity, cfg),
      stop: () => springRef.current?.stop(),
    }),
    []
  );

  useEffect(() => () => springRef.current?.stop(), []);

  return { ref: attach, ...api };
}

/**
 * Materialize a modal-style element from its anchored origin. The critically
 * damped spring is interruptible and avoids bounce for non-gestural motion.
 * Attach the returned ref to the element you want to appear.
 */
export function useFluidAppear<T extends HTMLElement = HTMLElement>(cfg?: SpringConfig) {
  const ref = useRef<T | null>(null);
  const springRef = useRef<Spring | null>(null);

  const attach = useCallback(
    (el: T | null) => {
      if (!el) return;
      ref.current = el;
      el.style.willChange = "transform, opacity";
      const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      const apply = (k: number) => {
        const progress = Math.min(1, Math.max(0, k));
        el.style.opacity = String(progress);
        el.style.transform = reduce ? "none" : `translate3d(0,${(1 - progress) * 8}px,0) scale(${0.975 + 0.025 * progress})`;
      };
      const s = new Spring(0, 1, cfg ?? springModal, apply, () => {
        el.style.willChange = "auto";
      });
      springRef.current = s;
      s.retarget(1);
    },
    [cfg]
  );

  useEffect(() => () => springRef.current?.stop(), []);

  return attach;
}
