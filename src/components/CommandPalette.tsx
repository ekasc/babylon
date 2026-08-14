import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CommandInfo, ProjectGroup, SessionMeta } from "../bridge";
import { buildPaletteIndex, searchPalette, type PaletteResult } from "../paletteSearch";
import { PiMark } from "./icons";

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
  // Worker results arrive async; null means the worker hasn't answered yet.
  const [workerResults, setWorkerResults] = useState<PaletteResult[] | null>(null);
  const [workerAvailable, setWorkerAvailable] = useState(false);
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const queryIdRef = useRef(0);
  const queryRef = useRef("");
  queryRef.current = query.trim().toLowerCase();

  // One worker for the palette's lifetime; rebuilt when the data set changes.
  useEffect(() => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL("../paletteWorker.ts", import.meta.url), { type: "module" });
    } catch {
      worker = null; // file:// production: fall back to the inline path below.
    }
    if (worker) {
      worker.onmessage = (event) => {
        const data = event.data;
        if (data?.type !== "results" || data.id !== queryIdRef.current) return;
        setWorkerResults(data.results);
      };
      worker.postMessage({ type: "index", groups, commands });
      worker.postMessage({ type: "query", id: queryIdRef.current, query: queryRef.current });
      setWorkerAvailable(true);
    }
    workerRef.current = worker;
    return () => {
      worker?.terminate();
      workerRef.current = null;
      setWorkerAvailable(false);
      setWorkerResults(null);
    };
  }, [groups, commands]);

  useEffect(() => {
    if (!workerRef.current) return;
    const id = ++queryIdRef.current;
    workerRef.current.postMessage({ type: "query", id, query: queryRef.current });
  }, [query]);

  // Inline fallback (no worker): identical search behavior, deferred. The
  // index is built once per data change, not per keystroke, and the fallback
  // is skipped entirely while a worker is answering.
  const inlineIndex = useMemo(() => buildPaletteIndex(groups, commands), [groups, commands]);
  const inlineResults = useMemo<PaletteResult[]>(
    () => (workerAvailable ? [] : searchPalette(inlineIndex, deferred)),
    [inlineIndex, deferred, workerAvailable]
  );
  const results = workerAvailable
    ? (workerResults ?? [{ type: "new", key: "new" }])
    : inlineResults;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);
  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, results.length - 1)));
  }, [results]);

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
