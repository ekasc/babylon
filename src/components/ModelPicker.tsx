import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

const RECENTS_KEY = "babylon:recent-models";
const MAX_RECENT = 5;
const RECENT_LABEL = "Recent";

const fmtWin = (n?: number) => (n ? `${Math.round(n / 1000)}k` : "—");
const fmtCost = (n?: number) => (n ? `$${n.toFixed(2)}/M` : "—");

function loadRecents(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

interface Group {
  label: string;
  models: Model[];
}

export default function ModelPicker({ models, current, disabled, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(loadRecents);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const currentKey = current ? `${current.provider}/${current.id}` : "";
  const searching = query.trim().length > 0;

  // Ranked filter: prefix and name hits outrank substring hits.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    const scored = models
      .map((m) => {
        const name = (m.name ?? "").toLowerCase();
        const id = m.id.toLowerCase();
        const provider = m.provider.toLowerCase();
        let score = -1;
        if (name.startsWith(q)) score = 0;
        else if (id.startsWith(q)) score = 1;
        else if (name.includes(q)) score = 2;
        else if (id.includes(q)) score = 3;
        else if (provider.includes(q)) score = 4;
        return { m, score };
      })
      .filter((s) => s.score >= 0);
    scored.sort((a, b) => a.score - b.score || a.m.id.localeCompare(b.m.id));
    return scored.map((s) => s.m);
  }, [models, query]);

  // Tabs: Recent (when there is any) + one per provider.
  const tabs = useMemo<Group[]>(() => {
    const out: Group[] = [];
    if (!searching && recent.length > 0) {
      const rec = recent
        .map((key) => models.find((m) => `${m.provider}/${m.id}` === key))
        .filter((m): m is Model => !!m);
      if (rec.length > 0) out.push({ label: RECENT_LABEL, models: rec });
    }
    const byProvider = new Map<string, Model[]>();
    for (const m of filtered) {
      const arr = byProvider.get(m.provider) ?? [];
      arr.push(m);
      byProvider.set(m.provider, arr);
    }
    // Sort by name/id within each group: the models prop arrives from the pi
    // registry in unstable insertion order and gets rebuilt behind our back;
    // without a derived sort, rows permute after mount and any scroll-to-
    // selected lands stale.
    const byName = (a: Model, b: Model) =>
      (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id);
    for (const [label, ms] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push({ label, models: [...ms].sort(byName) });
    }
    return out;
  }, [filtered, recent, models, searching]);

  // While searching, the right pane spans every provider; otherwise it shows
  // the active tab only.
  const visible = useMemo<Group[]>(() => {
    if (searching) return [{ label: "Results", models: filtered }];
    return tabs.filter((t) => t.label === activeLabel);
  }, [searching, filtered, tabs, activeLabel]);

  const flat = useMemo(() => visible.flatMap((g) => g.models), [visible]);

  // Opening lands on the current model's provider tab.
  useLayoutEffect(() => {
    if (!open) return;
    setActiveLabel((prev) => {
      if (!searching && prev && tabs.some((t) => t.label === prev)) return prev;
      const cur = models.find((m) => `${m.provider}/${m.id}` === currentKey);
      if (cur && !searching) return cur.provider;
      return tabs[0]?.label ?? null;
    });
    searchRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Single owner for initial highlight placement: whenever the visible pane
  // takes shape (open, tab switch, new query), land on the current model if
  // this pane contains it, else row 0. Must be a layout effect so placement
  // resolves pre-paint, and must be the ONLY writer — passive resets were
  // clobbering this value after paint.
  useLayoutEffect(() => {
    if (!open || flat.length === 0) return;
    const idx = flat.findIndex((m) => `${m.provider}/${m.id}` === currentKey);
    setHi(idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeLabel, query]);

  // Keep the highlighted row in view. Attached as a ref callback on whichever
  // row is highlighted. NOTE: resolve the scroll container from the row itself
  // (rows are direct children of the pane), NOT from listRef — React attaches
  // child refs before parent refs, so on a fresh popover mount listRef is
  // still null here and the scroll silently no-ops.
  //
  // Uses layout offsets (offsetTop/offsetHeight), NOT getBoundingClientRect:
  // the popover mounts with a scale(.98) entrance animation, and transformed
  // rects measure every distance ~2% short while it runs — the scroll lands
  // short and never corrects. Layout offsets are pre-transform and stable.
  const scrollRowIntoView = useCallback(
    (el: HTMLElement | null) => {
      if (!el || !open) return;
      const container = el.parentElement;
      if (!container) return;
      const relTop = el.offsetTop - container.offsetTop;
      const relBottom = relTop + el.offsetHeight;
      const visibleTop = container.scrollTop;
      const visibleBottom = visibleTop + container.clientHeight;
      if (relTop < visibleTop) {
        container.scrollTop = relTop;
      } else if (relBottom > visibleBottom) {
        container.scrollTop = relBottom - container.clientHeight;
      }
    },
    [open]
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  // Keyboard: ↑↓ move within the pane, ←→ switch provider tabs, Enter picks,
  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHi((i) => Math.min(i + 1, flat.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHi((i) => Math.max(i - 1, 0));
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !searching && tabs.length > 0) {
        e.preventDefault();
        setActiveLabel((prev) => {
          const idx = tabs.findIndex((t) => t.label === prev);
          const next = e.key === "ArrowRight" ? Math.min(idx + 1, tabs.length - 1) : Math.max(idx - 1, 0);
          return tabs[next === -1 ? 0 : next].label;
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const m = flat[hi];
        if (m) pick(m.provider, m.id);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, flat, hi, searching, tabs]);

  const pick = (provider: string, id: string) => {
    const key = `${provider}/${id}`;
    setRecent((prev) => {
      const next = [key, ...prev.filter((k) => k !== key)].slice(0, MAX_RECENT);
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      return next;
    });
    onSelect(provider, id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || !models.length}
        title={currentKey ? `Switch model — ${currentKey}` : "Switch model"}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="operator-meta-control flex h-8 max-w-[220px] items-center gap-1.5 px-2.5 text-[13px] disabled:opacity-50"
      >
        <CpuIcon size={12} className="shrink-0 text-dim" />
        {current ? (
          <span className="min-w-0 truncate">
            <span className="text-dim">{current.provider}/</span>
            <span>{current.name ?? current.id}</span>
          </span>
        ) : (
          <span className="min-w-0 truncate text-dim">select model</span>
        )}
        <ChevronIcon size={10} className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`} />
      </button>

      {open && (
        <div className="operator-popover absolute bottom-full left-0 z-50 mb-2 w-[460px] max-w-[calc(100vw-32px)] overflow-hidden p-1.5">
          <div className="border-b border-line/60 p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all providers…"
              aria-label="Search models"
              className="text-input"
            />
          </div>
          {!searching && tabs.length > 0 ? (
            <div className="flex h-[340px]">
              <div role="tablist" aria-label="Providers" className="w-[128px] shrink-0 overflow-y-auto border-r border-line/60 py-1">
                {tabs.map((t) => {
                  const selected = t.label === activeLabel;
                  return (
                    <button
                      key={t.label}
                      role="tab"
                      aria-selected={selected}
                      onClick={() => {
                        setActiveLabel(t.label);
                        setQuery("");
                      }}
                      className={`flex w-full items-center justify-between gap-1 rounded-md px-2.5 py-1.5 text-left transition-colors duration-100 ${
                        selected ? "font-medium text-accent" : "text-dim hover:text-fg"
                      }`}
                    >
                      <span className="min-w-0 truncate text-[12.5px]">{t.label}</span>
                      <span className="shrink-0 font-mono text-[10px] text-dim/70">{t.models.length}</span>
                    </button>
                  );
                })}
              </div>
              <div ref={listRef} role="listbox" aria-label={`${activeLabel ?? ""} models`} className="min-w-0 flex-1 overflow-y-auto py-1">
                {(visible[0]?.models ?? []).map((m) => {
                  const key = `${m.provider}/${m.id}`;
                  const idx = flat.indexOf(m);
                  const active = idx === hi;
                  const isCurrent = key === currentKey;
                  return (
                    <button
                      key={key}
                      id={`model-opt-${idx}`}
                      ref={active ? scrollRowIntoView : undefined}
                      role="option"
                      aria-selected={isCurrent}
                      data-idx={idx}
                      onMouseEnter={() => setHi(idx)}
                      onClick={() => pick(m.provider, m.id)}
                      className={`flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left transition-colors duration-100 ${
                        active ? "bg-fg/[0.1]" : ""
                      } ${isCurrent ? "text-accent" : ""}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className={`flex items-center gap-1.5 ${isCurrent ? "font-semibold text-accent" : active ? "text-fg" : "text-fg/85"}`}>
                          <span className="truncate text-[13px]">{m.name ?? m.id}</span>
                          {m.reasoning && (
                            <SparkleIcon size={9} className="shrink-0 text-dim" />
                          )}
                        </span>
                        <span className="mt-px block truncate font-mono text-[11px] leading-4 text-dim/80">
                          {fmtWin(m.contextWindow)} ctx · in {fmtCost(m.cost?.input)} / out {fmtCost(m.cost?.output)}
                        </span>
                      </span>
                      {isCurrent && <CheckIcon size={11} className="shrink-0 text-accent" />}
                      {!isCurrent && active && (
                        <kbd className="shrink-0 rounded border border-line bg-bg px-1.5 py-px font-mono text-[10px] leading-4 text-dim">↵</kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div ref={listRef} role="listbox" aria-label="Search results" className="max-h-[340px] min-w-0 overflow-y-auto py-1">
              {flat.length === 0 && (
                <p className="px-3 py-4 text-center text-[13px] text-dim">No models match “{query}”</p>
              )}
              {flat.map((m) => {
                const key = `${m.provider}/${m.id}`;
                const idx = flat.indexOf(m);
                const active = idx === hi;
                const isCurrent = key === currentKey;
                return (
                  <button
                    key={key}
                    id={`model-opt-${idx}`}
                    ref={active ? scrollRowIntoView : undefined}
                    role="option"
                    aria-selected={isCurrent}
                    data-idx={idx}
                    onMouseEnter={() => setHi(idx)}
                    onClick={() => pick(m.provider, m.id)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left transition-colors duration-100 ${
                      active ? "bg-fg/[0.1]" : ""
                    } ${isCurrent ? "text-accent" : ""}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={`flex items-center gap-1.5 ${isCurrent ? "font-semibold text-accent" : active ? "text-fg" : "text-fg/85"}`}>
                        <span className="truncate text-[13px]">{m.name ?? m.id}</span>
                        {m.reasoning && (
                          <SparkleIcon size={9} className="shrink-0 text-dim" />
                        )}
                      </span>
                      <span className="mt-px block truncate font-mono text-[11px] leading-4 text-dim/80">
                        {m.provider}/{m.id} · {fmtWin(m.contextWindow)} ctx · in {fmtCost(m.cost?.input)} / out {fmtCost(m.cost?.output)}
                      </span>
                    </span>
                    {isCurrent && <CheckIcon size={11} className="shrink-0 text-accent" />}
                    {!isCurrent && active && (
                      <kbd className="shrink-0 rounded border border-line bg-bg px-1.5 py-px font-mono text-[10px] leading-4 text-dim">↵</kbd>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
