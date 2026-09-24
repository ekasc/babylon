import { useRef, useState } from "react";
import { CheckIcon, ChevronIcon } from "./icons";
import { PopoverPanel, PopoverRoot, PopoverTrigger } from "./ui/Popover";

export interface HistoryEntry {
  path: string;
  cwd: string;
  title: string;
  projectName: string;
  mtime: number;
  open: boolean;
}

function timeAgo(ms: number): string {
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Compact session-history control for the end of the tab strip.
 * Recent sessions across Spaces; reopening one adds it back as a tab.
 */
export function SessionHistoryMenu({
  entries,
  onOpen,
}: {
  entries: HistoryEntry[];
  onOpen(entry: HistoryEntry): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={rootRef} className="relative">
      <PopoverRoot open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          title="Session history"
          aria-label="Session history"
          aria-haspopup="dialog"
          className="grid h-7 w-7 place-items-center rounded-md text-dim hover:bg-inset hover:text-fg"
        >
          <ChevronIcon size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </PopoverTrigger>
        <PopoverPanel
          container={rootRef.current}
          side="bottom"
          align="end"
          sideOffset={4}
          matchTriggerWidth={false}
          collisionAvoidance={{ side: "none", align: "shift" }}
          positionerClassName="z-50"
          className="operator-popover max-h-[320px] w-[320px] max-w-[calc(100vw-32px)] overflow-y-auto p-1.5"
        >
          <div className="palette-header">Recent sessions</div>
          {entries.length === 0 ? (
            <p className="px-3 py-4 text-center text-[13px] text-dim">No sessions yet.</p>
          ) : (
            entries.map((e) => (
              <button
                key={e.path}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpen(e);
                }}
                title={`${e.title} · ${e.cwd}`}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-inset"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{e.title}</span>
                  <span className="block truncate text-[11px] text-dim">
                    {e.projectName} · {timeAgo(e.mtime)}
                  </span>
                </span>
                {e.open ? (
                  <CheckIcon size={11} className="shrink-0 text-accent" aria-label="Open" />
                ) : null}
              </button>
            ))
          )}
        </PopoverPanel>
      </PopoverRoot>
    </div>
  );
}
