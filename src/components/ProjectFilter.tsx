import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronIcon } from "./icons";

interface Props {
  projects: { cwd: string; name: string }[];
  value: string;
  onChange: (cwd: string) => void;
}

export default function ProjectFilter({ projects, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const options = [{ cwd: "all", name: "All projects" }, ...projects];
  const current = options.find((o) => o.cwd === value) ?? options[0];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current.name}
        className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[15px] font-semibold tracking-[-0.01em] hover:bg-inset"
      >
        <span className="truncate">{current.name}</span>
        <ChevronIcon size={13} className={`shrink-0 text-dim transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="thread-menu absolute left-0 right-0 z-50 mt-1 max-h-64 overflow-y-auto">
          {options.map((o) => (
            <button
              key={o.cwd}
              type="button"
              role="option"
              aria-selected={o.cwd === value}
              onClick={() => {
                onChange(o.cwd);
                setOpen(false);
              }}
              className={`thread-menu-item ${o.cwd === value ? "is-selected" : ""}`}
            >
              <span className="truncate">{o.name}</span>
              {o.cwd === value && <CheckIcon size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
