import { useEffect, useRef } from "react";
import { MoreIcon } from "./icons";

export default function PanelsMenu({ open, onOpenChange, items }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  items: Array<{ label: string; open?: boolean; onToggle?(): void; badge?: number; action?(): void }>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onOpenChange(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => onOpenChange(!open)}
        title="More panels"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`thread-action ${open ? "is-active" : ""}`}
      >
        <MoreIcon size={16} />
      </button>
      {open && (
        <div role="menu" aria-label="Panels" className="thread-menu absolute right-0 top-full z-50 mt-2 min-w-[200px]">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitemcheckbox"
              aria-checked={item.open ?? false}
              onClick={() => {
                if (item.action) item.action();
                else item.onToggle?.();
              }}
              className="thread-menu-item"
            >
              <span>{item.label}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {item.badge ? <span className="sidebar-count">{item.badge}</span> : null}
                {item.open ? <span className="text-accent">✓</span> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
