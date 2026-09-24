import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { CheckIcon, ChevronIcon } from "./icons";

interface Props {
  projects: { cwd: string; name: string }[];
  value: string;
  onChange: (cwd: string) => void;
}

export default function ProjectFilter({ projects, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const options = [{ cwd: "all", name: "All projects" }, ...projects];
  const current = options.find((o) => o.cwd === value) ?? options[0];
  // Unreachable: options always carries the "All projects" head. Returning
  // null keeps the impossible case visible instead of asserting it away.
  if (!current) return null;

  // Base UI Popover owns open state, Escape, outside-press dismissal, and
  // floating placement. Anchored to the root (not the trigger) with the
  // anchor-width so the list keeps its old full-width `left-0 right-0` look.
  return (
    <Popover.Root open={open} onOpenChange={(next) => setOpen(next)}>
      <div ref={rootRef}>
        <Popover.Trigger
          type="button"
          title={current.name}
          className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[15px] font-semibold tracking-[-0.01em] hover:bg-inset"
        >
          <span className="truncate">{current.name}</span>
          <ChevronIcon size={13} className={`shrink-0 text-dim transition-transform ${open ? "rotate-180" : ""}`} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            anchor={rootRef}
            side="bottom"
            align="start"
            sideOffset={4}
            className="z-50"
          >
            <Popover.Popup
              initialFocus={false}
              style={{ width: "var(--anchor-width)" }}
              className="thread-menu max-h-64 overflow-y-auto"
            >
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
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </div>
    </Popover.Root>
  );
}
