import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CommandInfo, ProjectGroup, SessionMeta } from "../bridge";
import { rankCommands } from "../commands";
import { PiMark } from "./icons";

type Result =
  | { type: "new"; key: "new" }
  | { type: "session"; key: string; session: SessionMeta; cwd: string }
  | { type: "command"; key: string; command: CommandInfo };

export default function CommandPalette({
  groups,
  commands,
  onClose,
  onNew,
  onOpen,
  onCommand,
}: {
  groups: ProjectGroup[];
  commands: CommandInfo[];
  onClose(): void;
  onNew(): void;
  onOpen(path: string, cwd: string): void;
  onCommand(command: CommandInfo): void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const results = useMemo<Result[]>(() => {
    const sessions = groups
      .flatMap((group) => group.sessions.map((session) => ({ session, cwd: group.cwd })))
      .filter(({ session, cwd }) => !deferred || `${session.name ?? ""} ${session.firstUserText ?? ""} ${cwd}`.toLowerCase().includes(deferred))
      .sort((a, b) => b.session.mtime - a.session.mtime)
      .slice(0, deferred ? 20 : 8)
      .map(({ session, cwd }) => ({ type: "session" as const, key: session.path, session, cwd }));
    const commandResults = rankCommands(commands, deferred, deferred ? 16 : 8).map((command) => ({
      type: "command" as const,
      key: `${command.source}:${command.name}`,
      command,
    }));
    return [{ type: "new", key: "new" }, ...sessions, ...commandResults];
  }, [groups, commands, deferred]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);
  useEffect(() => setSelected(0), [deferred]);

  const choose = (result = results[selected]) => {
    if (!result) return;
    if (result.type === "new") onNew();
    else if (result.type === "session") onOpen(result.session.path, result.cwd);
    else onCommand(result.command);
    onClose();
  };

  return (
    <div className="fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="command-palette w-full max-w-2xl overflow-hidden"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab" || !dialogRef.current) return;
          const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("input, button, [tabindex]:not([tabindex='-1'])")];
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
        }}
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
          <PiMark size={18} className="text-accent" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              else if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((index) => (index + 1) % results.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((index) => (index - 1 + results.length) % results.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose();
              }
            }}
            placeholder="Jump to a session or command…"
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-dim"
          />
          <kbd className="rounded border border-line bg-inset px-2 py-1 text-[12px] text-dim">Esc</kbd>
        </div>
        <div role="listbox" className="max-h-[58vh] overflow-y-auto p-2">
          {results.map((result, index) => {
            const active = index === selected;
            if (result.type === "new") {
              return <PaletteRow key={result.key} active={active} title="New session…" meta="action" onHover={() => setSelected(index)} onChoose={() => choose(result)} />;
            }
            if (result.type === "session") {
              const project = result.cwd.split("/").filter(Boolean).pop() ?? result.cwd;
              return <PaletteRow key={result.key} active={active} title={result.session.name ?? result.session.firstUserText ?? result.session.id.slice(0, 8)} description={project} meta="session" onHover={() => setSelected(index)} onChoose={() => choose(result)} />;
            }
            return <PaletteRow key={result.key} active={active} title={`/${result.command.name}`} description={result.command.description} meta={result.command.source} onHover={() => setSelected(index)} onChoose={() => choose(result)} />;
          })}
        </div>
        <div className="border-t border-line px-4 py-2.5 text-[12px] text-dim">↑↓ Navigate · Enter to open · ⌘K to close</div>
      </div>
    </div>
  );
}

function PaletteRow({ active, title, description, meta, onHover, onChoose }: { active: boolean; title: string; description?: string; meta: string; onHover(): void; onChoose(): void }) {
  return <button role="option" aria-selected={active} onMouseEnter={onHover} onClick={onChoose} className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left ${active ? "bg-accent-soft" : "hover:bg-inset"}`}><span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{title}</span>{description ? <span className="mt-0.5 block truncate text-[13px] text-dim">{description}</span> : null}</span><span className="text-[12px] text-dim">{meta}</span></button>;
}
