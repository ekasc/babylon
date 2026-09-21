import { useEffect } from "react";

/**
 * Floating prototype switcher. Cycles variants, syncs `?variant=` to the URL,
 * and binds ← / → (ignored while typing). Never ships: hidden in prod builds.
 */
export function PrototypeSwitcher({
  variants,
  current,
  nameFor,
  onSelect,
}: {
  variants: readonly string[];
  current: string;
  nameFor: (v: string) => string;
  onSelect: (v: string) => void;
}) {
  const idx = variants.indexOf(current);
  const go = (delta: number) => {
    const next = variants[(idx + delta + variants.length) % variants.length];
    if (next !== undefined) onSelect(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (import.meta.env.PROD) return null;

  const btn = "grid h-7 w-7 place-items-center rounded-full text-white hover:bg-white/15";

  return (
    <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-black/85 px-2 py-1.5 text-[12px] text-white shadow-xl backdrop-blur">
      <button className={btn} onClick={() => go(-1)} aria-label="Previous variant">
        ←
      </button>
      <span className="min-w-[190px] px-1 text-center font-medium">
        <span className="font-mono text-white/60">{current}</span>
        {" — "}
        {nameFor(current)}
      </span>
      <button className={btn} onClick={() => go(1)} aria-label="Next variant">
        →
      </button>
    </div>
  );
}
