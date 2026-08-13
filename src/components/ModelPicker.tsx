import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronIcon, CpuIcon, SparkleIcon } from "./icons";

interface Model {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  cost?: { input?: number; output?: number; cacheRead?: number };
  reasoning?: boolean;
}

interface Props {
  models: Model[];
  current?: Model | null;
  disabled?: boolean;
  onSelect(provider: string, modelId: string): void;
}

const fmtWin = (n?: number) => (n ? `${Math.round(n / 1000)}k` : "—");
const fmtCost = (n?: number) => (n ? `$${n.toFixed(2)}/M` : "—");

export default function ModelPicker({ models, current, disabled, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const currentKey = current ? `${current.provider}/${current.id}` : "";

  // Group by provider; filter by query (provider, id, name).
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = models.filter((m) => {
      if (!q) return true;
      return (
        m.provider.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.name ?? "").toLowerCase().includes(q)
      );
    });
    const map = new Map<string, Model[]>();
    for (const m of filtered) {
      const arr = map.get(m.provider) ?? [];
      arr.push(m);
      map.set(m.provider, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Scroll the active item into view when opening.
  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
    searchRef.current?.focus();
  }, [open]);

  const pick = (provider: string, id: string) => {
    onSelect(provider, id);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || !models.length}
        title="Switch model"
        className="operator-meta-control flex h-8 max-w-[260px] items-center gap-1.5 px-2.5 text-[13px] disabled:opacity-50"
      >
        <CpuIcon size={12} className="shrink-0 text-dim" />
        <span className="min-w-0 truncate">
          {currentKey ? `${current!.provider}/${current!.id}` : "select model"}
        </span>
        <ChevronIcon size={10} className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`} />
      </button>

      {open && (
        <div className="operator-popover absolute bottom-full left-0 z-50 mb-2 w-[410px] max-w-[calc(100vw-32px)] overflow-hidden">
          <div className="border-b border-line/60 p-3">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-[14px] outline-none placeholder:text-dim focus:border-accent/50"
            />
          </div>
          <div ref={listRef} className="max-h-[360px] overflow-y-auto py-1.5">
            {groups.length === 0 && (
              <p className="px-3 py-4 text-center text-[13px] text-dim">No models match “{query}”</p>
            )}
            {groups.map(([provider, ms]) => (
              <div key={provider}>
                <p className="px-4 pb-1.5 pt-3.5 text-[12px] font-semibold text-dim">
                  {provider}
                </p>
                {ms.map((m) => {
                  const key = `${m.provider}/${m.id}`;
                  const active = key === currentKey;
                  return (
                    <button
                      key={key}
                      data-active={active}
                      onClick={() => pick(m.provider, m.id)}
                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-inset ${
                        active ? "bg-accent-soft" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className={`flex items-center gap-1.5 ${active ? "font-semibold text-accent" : "text-fg"}`}>
                          <span className="truncate text-[14px]">{m.name ?? m.id}</span>
                          {m.reasoning && (
                            <SparkleIcon size={10} className="shrink-0 text-dim" />
                          )}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[12px] leading-5 text-dim">
                          {m.id} · {fmtWin(m.contextWindow)} ctx · in {fmtCost(m.cost?.input)} / out {fmtCost(m.cost?.output)}
                        </span>
                      </span>
                      {active && <CheckIcon size={12} className="shrink-0 text-accent" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
