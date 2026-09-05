import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CommandInfo, ProjectGroup, SessionMeta } from "../bridge";
import { buildPaletteIndex, searchPalette, type PaletteResult } from "../paletteSearch";
import { PiMark } from "./icons";

export type RailFilter =
  | "all"
  | "sessions"
  | "skills"
  | "extensions"
  | "templates"
  | "commands"
  | "models";

interface PaletteModel {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
}

const ROW_H = 56;
const HEADER_H = 30;
const OVERSCAN = 6;

const CATEGORY_ORDER: RailFilter[] = [
  "sessions",
  "skills",
  "extensions",
  "templates",
  "commands",
  "models",
];
const CATEGORY_LABEL: Record<Exclude<RailFilter, "all">, string> = {
  sessions: "Sessions",
  skills: "Skills",
  extensions: "Extensions",
  templates: "Templates",
  commands: "Commands",
  models: "Models",
};
const CATEGORY_BADGE: Record<Exclude<RailFilter, "all">, string> = {
  sessions: "session",
  skills: "skill",
  extensions: "extension",
  templates: "template",
  commands: "command",
  models: "model",
};

type CommandCategory = Exclude<RailFilter, "all" | "models">;

type RowData =
  | { category: CommandCategory; result: PaletteResult }
  | { category: "models"; model: PaletteModel };

function categoryForCommand(source: CommandInfo["source"]): CommandCategory {
  if (source === "skill") return "skills";
  if (source === "extension") return "extensions";
  if (source === "prompt") return "templates";
  return "commands";
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-accent-soft px-0.5 text-accent">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

export default function CommandPalette({
  groups,
  commands,
  filter = "all",
  models = [],
  onPickModel,
  onClose,
  onNew,
  onOpen,
  onCommand,
}: {
  groups: ProjectGroup[];
  commands: CommandInfo[];
  filter?: RailFilter;
  models?: PaletteModel[];
  onPickModel?(provider: string, modelId: string): void;
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
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

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
      worker.postMessage({ type: "query", id: queryIdRef.current, query: query.trim().toLowerCase() });
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
    workerRef.current.postMessage({ type: "query", id, query: query.trim().toLowerCase() });
  }, [query]);

  // Inline fallback (no worker): identical search behavior, deferred. The
  // index is built once per data change, not per keystroke, and the fallback
  // is skipped entirely while a worker is answering.
  const inlineIndex = useMemo(() => buildPaletteIndex(groups, commands), [groups, commands]);
  const inlineResults = useMemo<PaletteResult[]>(
    () => (workerAvailable ? [] : searchPalette(inlineIndex, deferred)),
    [inlineIndex, deferred, workerAvailable]
  );
  const paletteResults: PaletteResult[] = workerAvailable
    ? (workerResults ?? [{ type: "new", key: "new" }])
    : inlineResults;

  // Group the flat palette results by source. Commands already carry a
  // `source` ("skill" | "extension" | "prompt"); anything else lands in the
  // catch-all "commands" bucket. Only categories with items are shown.
  const byCat = useMemo(() => {
    const map: Record<CommandCategory, RowData[]> = {
      sessions: [],
      skills: [],
      extensions: [],
      templates: [],
      commands: [],
    };
    for (const r of paletteResults) {
      if (r.type === "new" || r.type === "session") map.sessions.push({ category: "sessions", result: r });
      else {
        const cat = categoryForCommand(r.command.source);
        map[cat].push({ category: cat, result: r });
      }
    }
    return map;
  }, [paletteResults]);

  // Models come from the host registry (no IPC change): filter by query when
  // the palette is unfiltered or explicitly showing models.
  const modelRows = useMemo(() => {
    if (filter !== "all" && filter !== "models") return [];
    if (!models.length) return [];
    if (!deferred) return models.map((m) => ({ category: "models" as const, model: m }));
    return models
      .filter((m) => `${m.name ?? m.id} ${m.id} ${m.provider}`.toLowerCase().includes(deferred))
      .map((m) => ({ category: "models" as const, model: m }));
  }, [models, deferred, filter]);

  const order = filter === "all" ? CATEGORY_ORDER : [filter];

  // Interleave category headers with their rows; compute absolute offsets so
  // the list can be virtualized with variable row/header heights.
  const { displayItems, rowItems, total, tops } = useMemo(() => {
    const items: Array<{ kind: "header"; label: string } | { kind: "row"; row: RowData; idx: number }> = [];
    const rows: RowData[] = [];
    let idx = 0;
    for (const cat of order) {
      const catRows = cat === "models" ? modelRows : byCat[cat as CommandCategory];
      if (!catRows.length) continue;
      items.push({ kind: "header", label: CATEGORY_LABEL[cat as Exclude<RailFilter, "all">] });
      for (const row of catRows) {
        items.push({ kind: "row", row, idx });
        rows.push(row);
        idx++;
      }
    }
    const heights = items.map((it) => (it.kind === "header" ? HEADER_H : ROW_H));
    const topsArr = new Array<number>(heights.length + 1);
    topsArr[0] = 0;
    for (let i = 0; i < heights.length; i++) topsArr[i + 1] = topsArr[i] + heights[i];
    return { displayItems: items, rowItems: rows, total: topsArr[heights.length], tops: topsArr };
  }, [order, byCat, modelRows]);

  const viewportH = 420; // ~58vh capped, matches max-h-[58vh]
  const findFirst = (y: number) => {
    // First index whose bottom edge is past y.
    let lo = 0;
    let hi = tops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const start = Math.max(0, findFirst(scrollTop) - OVERSCAN);
  const end = Math.min(displayItems.length, findFirst(scrollTop + viewportH) + OVERSCAN);
  const virtual = displayItems.slice(start, end);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);
  useEffect(() => {
    setSelected(0);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query, filter]);
  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, rowItems.length - 1)));
  }, [rowItems]);

  const choose = (row: RowData | undefined = rowItems[selected]) => {
    if (!row) return;
    if (row.category === "models") onPickModel?.(row.model.provider, row.model.id);
    else {
      const r = row.result;
      if (r.type === "new") onNew();
      else if (r.type === "session") onOpen(r.session.path, r.cwd);
      else onCommand(r.command);
    }
    onClose();
  };

  return (
    <div
      className="fade-in fixed inset-0 z-[70] flex items-start justify-center bg-[var(--scrim)] px-4 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="command-palette w-full max-w-2xl overflow-hidden"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab" || !dialogRef.current) return;
          const focusable = [
            ...dialogRef.current.querySelectorAll<HTMLElement>("input, button, [tabindex]:not([tabindex='-1'])"),
          ];
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
                if (!rowItems.length) return;
                setSelected((index) => (index + 1) % rowItems.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (!rowItems.length) return;
                setSelected((index) => (index - 1 + rowItems.length) % rowItems.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose();
              }
            }}
            placeholder="Jump to a session, skill, or command…"
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-dim"
          />
          <kbd className="rounded border border-line bg-inset px-2 py-1 text-[12px] text-dim">Esc</kbd>
        </div>
        <div
          ref={listRef}
          role="listbox"
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          className="max-h-[58vh] overflow-y-auto p-2"
          style={{ contain: "strict" }}
        >
          {rowItems.length === 0 ? (
            <div className="px-3 py-8 text-center text-[13px] text-dim">No matches</div>
          ) : (
            <div style={{ position: "relative", height: total }}>
              {virtual.map((item, k) => {
                const index = start + k;
                const top = tops[index];
                if (item.kind === "header") {
                  return (
                    <div
                      key={`header-${item.label}`}
                      className="palette-header"
                      style={{ position: "absolute", top, left: 0, right: 0, height: HEADER_H }}
                    >
                      {item.label}
                    </div>
                  );
                }
                const row = item.row;
                const active = item.idx === selected;
                const badge = row.category === "models" ? "model" : row.result.type === "new" ? "new" : CATEGORY_BADGE[row.category];
                let title: string;
                let description: string | undefined;
                if (row.category === "models") {
                  title = row.model.name ?? row.model.id;
                  description = row.model.provider;
                } else if (row.result.type === "new") {
                  title = "New session…";
                  description = "Start a fresh chat";
                } else if (row.result.type === "session") {
                  const project = row.result.cwd.split("/").filter(Boolean).pop() ?? row.result.cwd;
                  title = row.result.session.name ?? row.result.session.firstUserText ?? row.result.session.id.slice(0, 8);
                  description = project;
                } else {
                  title = `/${row.result.command.name}`;
                  description = row.result.command.description;
                }
                const key =
                  row.category === "models"
                    ? `model:${row.model.provider}/${row.model.id}`
                    : `result:${row.result.key}`;
                return (
                  <div
                    key={key}
                    style={{ position: "absolute", top, left: 0, right: 0, height: ROW_H }}
                  >
                    <PaletteRow
                      active={active}
                      title={title}
                      description={description}
                      badge={badge}
                      query={deferred}
                      onHover={() => setSelected(item.idx)}
                      onChoose={() => choose(row)}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="border-t border-line px-4 py-2.5 text-[12px] text-dim">
          ↑↓ Navigate · Enter to open · ⌘K to close
        </div>
      </div>
    </div>
  );
}

function PaletteRow({
  active,
  title,
  description,
  badge,
  query,
  onHover,
  onChoose,
}: {
  active: boolean;
  title: string;
  description?: string;
  badge: string;
  query: string;
  onHover(): void;
  onChoose(): void;
}) {
  return (
    <button
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={onChoose}
      style={{ height: ROW_H }}
      className={`flex w-full items-center gap-3 rounded-md px-3 text-left ${
        active ? "bg-accent-soft" : "hover:bg-inset"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">
          <Highlight text={title} query={query} />
        </span>
        {description ? (
          <span className="mt-0.5 block truncate text-[13px] text-dim">
            <Highlight text={description} query={query} />
          </span>
        ) : null}
      </span>
      <span className="palette-badge">{badge}</span>
    </button>
  );
}
