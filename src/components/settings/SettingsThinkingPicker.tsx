import { useMemo, useRef, useState } from "react";
import { PopoverPanel, PopoverRoot, PopoverTrigger } from "../ui/Popover";
import { BoltIcon, CheckIcon, ChevronIcon } from "../icons";

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
  available?: string[];
  disabled?: boolean;
  onSelect(level: string): void;
}

export default function SettingsThinkingPicker({ current, available, disabled, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const levels = useMemo(() => {
    const supported = available && available.length ? new Set(available) : null;
    return Object.keys(LEVEL_META).filter((l) => !supported || supported.has(l));
  }, [available]);

  const meta = LEVEL_META[current] ?? { label: current, desc: "" };

  return (
    <div ref={rootRef} className="relative">
      <PopoverRoot open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          disabled={disabled}
          title="Reasoning level"
          className="operator-meta-control flex h-8 items-center gap-1.5 px-2.5 text-[13px] disabled:opacity-50 border border-line bg-inset/30 hover:bg-inset rounded-[var(--radius-sm)]"
        >
          <BoltIcon size={12} className="shrink-0 text-dim" />
          <span className="shrink-0">{meta.label}</span>
          <ChevronIcon size={10} className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`} />
        </PopoverTrigger>

        <PopoverPanel
          container={rootRef.current}
          side="bottom"
          align="end"
          sideOffset={8}
          matchTriggerWidth={false}
          positionerClassName="z-50"
          className="operator-popover w-[280px] max-w-[calc(100vw-32px)] overflow-hidden px-1.5 py-1.5"
        >
          {levels.map((l) => {
            const m = LEVEL_META[l];
            if (m === undefined) return null;
            const active = l === current;
            return (
              <button
                key={l}
                onClick={() => {
                  onSelect(l);
                  setOpen(false);
                }}
                className={`flex w-full items-start gap-3 rounded-[var(--radius-sm)] px-3 py-2.5 text-left hover:bg-inset ${
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
