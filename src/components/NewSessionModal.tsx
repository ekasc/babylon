import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, FolderIcon } from "./icons";
import { ProjectIcon } from "./ProjectIcon";
import { ModalDialog } from "./ui/Dialog";

export interface NewSessionProject {
  cwd: string;
  name: string;
  /** Max session mtime in this project, 0 when never used. */
  lastUsed: number;
}

interface Props {
  projects: NewSessionProject[];
  /** Active Space: pinned first and preselected, so `+` defaults to it. */
  defaultCwd?: string | null;
  onChoose(cwd: string): void;
  onPickFolder(): void;
  onClose(): void;
}

type Item = { kind: "project"; project: NewSessionProject } | { kind: "folder" };

function shortHome(cwd: string): string {
  return cwd.replace(/^\/Users\/[^/]+/, "~");
}

export default function NewSessionModal({ projects, defaultCwd, onChoose, onPickFolder, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const allCwds = useMemo(() => projects.map((p) => p.cwd), [projects]);
  const rows = useMemo(() => {
    const sorted = [...projects].sort((a, b) => {
      if (defaultCwd) {
        if (a.cwd === defaultCwd) return -1;
        if (b.cwd === defaultCwd) return 1;
      }
      return b.lastUsed - a.lastUsed;
    });
    const q = query.trim().toLowerCase();
    const items: Item[] = (q
      ? sorted.filter(
          (p) => p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q)
        )
      : sorted
    ).map((project) => ({ kind: "project", project }) as Item);
    items.push({ kind: "folder" });
    return items;
  }, [projects, query, defaultCwd]);

  // Base UI ModalDialog owns focus entry/restoration, Tab trapping,
  // Escape, and outside-press dismissal. The input keeps Babylon's
  // ArrowUp/Down/Enter/Backspace/Cmd+number selection model.
  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const choose = (item: Item | undefined = rows[selected]) => {
    if (!item) return;
    if (item.kind === "project") onChoose(item.project.cwd);
    else onPickFolder();
  };

  return (
    <ModalDialog
      onClose={onClose}
      backdropClassName="fade-in fixed inset-0 z-[70] bg-[var(--scrim)]"
      viewportClassName="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[12vh]"
      popupClassName="command-palette w-full max-w-2xl overflow-hidden"
      ariaLabel="New session"
      initialFocus={inputRef}
    >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
          <button onClick={onClose} aria-label="Back" title="Back" className="context-icon-button">
            <ArrowLeftIcon size={15} />
          </button>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Backspace" && query === "") onClose();
              else if (event.key === "ArrowDown") {
                event.preventDefault();
                if (!rows.length) return;
                setSelected((index) => (index + 1) % rows.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (!rows.length) return;
                setSelected((index) => (index - 1 + rows.length) % rows.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose();
              } else if (event.metaKey && /^[1-9]$/.test(event.key)) {
                const index = Number(event.key) - 1;
                if (rows[index]?.kind === "project") {
                  event.preventDefault();
                  onChoose((rows[index] as { kind: "project"; project: NewSessionProject }).project.cwd);
                }
              }
            }}
            placeholder="Search projects…"
            aria-label="Search projects"
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-dim focus-visible:outline-none"
          />
        </div>

        <div role="listbox" aria-label="Projects" className="max-h-[46vh] overflow-y-auto p-2">
          <div className="palette-header">Projects</div>
          {query.trim() && rows.length === 1 ? (
            <div className="px-3 py-6 text-center text-[13px] text-dim">No matches</div>
          ) : null}
          {rows.map((item, index) => {
            if (item.kind === "folder") {
              const folderActive = index === selected;
              return (
                <button
                  key="__folder"
                  role="option"
                  aria-selected={folderActive}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => onPickFolder()}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left ${
                    folderActive ? "bg-accent-soft" : "hover:bg-accent-soft/60"
                  }`}
                >
                  <span className="grid h-5 w-5 shrink-0 place-items-center text-dim">
                    <FolderIcon size={15} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
                    Open another folder…
                  </span>
                </button>
              );
            }
            const active = index === selected;
            return (
              <button
                key={item.project.cwd}
                role="option"
                aria-selected={active}
                onMouseEnter={() => setSelected(index)}
                onClick={() => onChoose(item.project.cwd)}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left ${
                  active ? "bg-accent-soft" : "hover:bg-accent-soft/60"
                }`}
              >
                <ProjectIcon cwd={item.project.cwd} allCwds={allCwds} size={15} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">{item.project.name}</span>
                  <span className="mt-px block truncate text-[12px] text-dim">
                    {shortHome(item.project.cwd)}
                  </span>
                </span>
                {index < 9 ? (
                  <kbd className="shrink-0 text-[12px] tabular-nums text-dim">⌘{index + 1}</kbd>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 text-[12px] text-dim">
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-line bg-inset px-1.5 py-0.5 text-[11px]">↑</kbd>
            <kbd className="rounded border border-line bg-inset px-1.5 py-0.5 text-[11px]">↓</kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-line bg-inset px-1.5 py-0.5 text-[11px]">Enter</kbd>
            Select
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-line bg-inset px-1.5 py-0.5 text-[11px]">Backspace</kbd>
            Back
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-line bg-inset px-1.5 py-0.5 text-[11px]">Esc</kbd>
            Close
          </span>
        </div>
    </ModalDialog>
  );
}
