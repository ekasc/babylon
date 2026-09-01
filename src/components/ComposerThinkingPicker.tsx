import { useEffect, useMemo, useRef, useState } from "react";
import { BoltIcon, CheckIcon, ChevronIcon } from "./icons";

const LEVEL_META: Record<string, { label: string; desc: string }> = {
  off: { label: "Off", desc: "No reasoning — fastest responses" },
  minimal: { label: "Minimal", desc: "A little reasoning for simple tasks" },
  low: { label: "Low", desc: "Light reasoning on complex steps" },
  medium: { label: "Medium", desc: "Balanced reasoning for most work" },
  high: { label: "High", desc: "Deep reasoning for hard problems" },
  xhigh: { label: "X-High", desc: "Very deep reasoning" },
  max: { label: "Max", desc: "Maximum reasoning depth" },
};

interface Props {
  current: string;
  available?: string[]; // levels the model supports; if empty, assume all
  disabled?: boolean;
  align?: "left" | "right";
  onSelect(level: string): void;
}

export default function ThinkingPicker({ current, available, disabled, align = "left", onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const levels = useMemo(() => {
    const supported = available && available.length ? new Set(available) : null;
    return Object.keys(LEVEL_META).filter((l) => !supported || supported.has(l));
  }, [available]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const meta = LEVEL_META[current] ?? { label: current, desc: "" };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Reasoning level"
        className="operator-meta-control flex h-8 items-center gap-1.5 px-2.5 disabled:opacity-50"
      >
        <BoltIcon size={15} className="shrink-0 text-dim" />
        <span className="shrink-0">{meta.label}</span>
        <ChevronIcon size={10} className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`} />
      </button>

      {open && (
        <div className="operator-popover absolute bottom-full left-1/2 z-50 mb-2 w-[280px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden px-1.5 py-1.5 rounded-xl border border-white/10 bg-[#0F0F0F] shadow-xl">
          {levels.map((l) => {
            const m = LEVEL_META[l];
            const active = l === current;
            return (
              <button
                key={l}
                onClick={() => {
                  onSelect(l);
                  setOpen(false);
                }}
                className={`flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left hover:bg-inset ${
                  active ? "bg-accent-soft" : ""
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className={`block text-[14px] ${active ? "font-semibold text-accent" : "text-fg"}`}>
                    {m.label}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-5 text-dim">{m.desc}</span>
                </span>
                {active && <CheckIcon size={12} className="mt-0.5 shrink-0 text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
