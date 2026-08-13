import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Spring, springCritical } from "../lib/spring";

export default function WorkspacePane({
  children,
  width,
  onResizeStart,
}: {
  children: ReactNode;
  width: number;
  onResizeStart(event: React.PointerEvent<HTMLDivElement>): void;
}) {
  const paneRef = useRef<HTMLElement | null>(null);
  const springRef = useRef<Spring | null>(null);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    pane.style.willChange = "transform, opacity";
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      pane.style.opacity = "1";
      pane.style.transform = "none";
      return;
    }
    const spring = new Spring(1, 0, springCritical, (progress) => {
      pane.style.transform = `translate3d(${Math.max(0, progress) * 22}px,0,0)`;
      pane.style.opacity = String(Math.min(1, Math.max(0, 1 - progress * 0.45)));
    });
    springRef.current = spring;
    spring.retarget(0);
    return () => spring.stop();
  }, []);

  return (
    <aside ref={paneRef} className="context-workspace relative h-full shrink-0" style={{ width }}>
      <div
        className="context-resizer"
        role="separator"
        aria-label="Resize context workspace"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
      />
      {children}
    </aside>
  );
}
