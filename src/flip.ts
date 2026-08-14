import { useCallback, useLayoutEffect, useRef } from "react";

// Minimal FLIP for list reorders. Positions are captured at the end of every
// commit; on the next commit, moved rows are translated back to their old spot
// and spring to their new one with a transform transition. Pure visual layer:
// layout is never touched, and `prefers-reduced-motion` disables it entirely.

const FLIP_EASE = "transform 180ms cubic-bezier(.2,.8,.2,1)";

function prefersReducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Attach to a list whose rows carry stable ids. Returns a ref-callback that
 * binds each row element to its id. Rows reordered or repositioned between
 * renders glide to their new location instead of jumping.
 */
export function useFlipList(ids: readonly unknown[]): (node: HTMLElement | null, id: unknown) => void {
  const previous = useRef<Map<unknown, Point>>(new Map());
  const nodes = useRef(new Map<unknown, HTMLElement>());
  const mounted = useRef(false);

  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      previous.current = capture(nodes.current);
      return;
    }
    if (prefersReducedMotion()) {
      previous.current = capture(nodes.current);
      return;
    }
    const before = previous.current;
    const after = capture(nodes.current);
    for (const [id, el] of nodes.current) {
      const start = before.get(id);
      const end = after.get(id);
      if (!start || !end || (start.x === end.x && start.y === end.y)) continue;
      const dx = start.x - end.x;
      const dy = start.y - end.y;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      // Force reflow so the inverse transform is committed before animating.
      void el.offsetWidth;
      el.style.transition = FLIP_EASE;
      el.style.transform = "";
    }
    previous.current = after;
  }, [ids]);

  const attach = useCallback((node: HTMLElement | null, id: unknown) => {
    if (node) nodes.current.set(id, node);
    else nodes.current.delete(id);
  }, []);

  return attach;
}

function capture(nodes: Map<unknown, HTMLElement>): Map<unknown, Point> {
  const positions = new Map<unknown, Point>();
  for (const [id, el] of nodes) {
    const rect = el.getBoundingClientRect();
    positions.set(id, { x: rect.left, y: rect.top });
  }
  return positions;
}
