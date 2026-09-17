import { useMemo, useState } from "react";
import { BoltIcon, CheckIcon, ChevronIcon } from "./icons";
import { PopoverPanel, PopoverRoot, PopoverTrigger } from "./ui/Popover";

const LEVEL_META: Record<string, { label: string; desc: string }> = {
  off: { label: "Off", desc: "No reasoning, fastest responses" },
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

  const levels = useMemo(() => {
    const supported = available && available.length ? new Set(available) : null;
    return Object.keys(LEVEL_META).filter((l) => !supported || supported.has(l));
  }, [available]);

  const meta = LEVEL_META[current] ?? { label: current, desc: "" };

  // Dismissal (Escape, outside-press), trigger semantics, and floating
  // placement are owned by the popover primitive (body-portal mode escapes
  // the footer's isolated stacking context, as the manual portal did).
  return (
    <div className="relative">
      <PopoverRoot open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          disabled={disabled}
          title="Reasoning level"
          className="operator-meta-control flex h-8 items-center gap-1.5 px-2.5 disabled:opacity-50"
        >
          <BoltIcon size={15} className="shrink-0 text-dim" />
          <span className="shrink-0">{meta.label}</span>
          <ChevronIcon size={10} className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`} />
        </PopoverTrigger>

        <PopoverPanel
          side="top"
          align={align === "right" ? "end" : "start"}
          sideOffset={8}
          positionerClassName="z-[70]"
          className="operator-popover w-[280px] max-w-[calc(100vw-32px)] overflow-hidden px-1.5 py-1.5"
        >
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
                className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-inset ${
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
        </PopoverPanel>
      </PopoverRoot>
    </div>
  );
}
