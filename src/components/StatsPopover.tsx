import { useEffect, useRef, useState } from "react";
import { fmtTokens } from "../store";
import { CompressIcon, GaugeIcon } from "./icons";

interface Stats {
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  cost?: number;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
}

interface Props {
  stats: Stats | null;
  hasSession: boolean;
  onCompact(): void;
}

function fmtUsd(n?: number): string {
  if (n == null || n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[13px] text-dim">
        {label}
        {sub && <span className="ml-1 text-[12px] opacity-70">{sub}</span>}
      </span>
      <span className="font-mono text-[13px] text-fg">{value}</span>
    </div>
  );
}

export default function StatsPopover({ stats, hasSession, onCompact }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const cu = stats?.contextUsage;
  const pct = cu?.percent ?? null;
  const hasData = !!stats && !!hasSession;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={!hasData}
        title="Session usage"
        className="operator-meta-control flex h-8 items-center gap-1.5 px-2.5 text-[13px] disabled:opacity-40"
      >
        <GaugeIcon size={12} className="shrink-0 text-dim" />
        <span className="tabular-nums">{pct != null ? `${Math.round(pct)}%` : "—"}</span>
      </button>

      {open && (
        <div className="operator-popover absolute bottom-full right-0 z-50 mb-2 w-[320px] overflow-hidden">
          <div className="border-b border-line/60 px-4 py-3.5">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[13px] font-semibold text-dim">
                Context window
              </span>
              <span className="font-mono text-[12px] text-dim">
                {cu?.tokens != null ? fmtTokens(cu.tokens) : "—"} / {cu?.contextWindow ? fmtTokens(cu.contextWindow) : "—"}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-inset">
              <div
                className="h-full w-full origin-left rounded-full bg-accent transition-transform duration-300"
                style={{ transform: `scaleX(${Math.min(100, pct ?? 0) / 100})` }}
              />
            </div>
          </div>

          <div className="px-4 py-3">
            <Row label="Tokens" value={fmtTokens(stats?.tokens?.total)} />
            <Row label="input" sub="output" value={`${fmtTokens(stats?.tokens?.input)} / ${fmtTokens(stats?.tokens?.output)}`} />
            <Row label="cache" sub="read / write" value={`${fmtTokens(stats?.tokens?.cacheRead)} / ${fmtTokens(stats?.tokens?.cacheWrite)}`} />
            <Row label="Cost" value={fmtUsd(stats?.cost)} />
            <div className="my-1.5 border-t border-line/60" />
            <Row label="Messages" value={`${stats?.totalMessages ?? 0}`} />
            <Row label="user" sub="assistant" value={`${stats?.userMessages ?? 0} / ${stats?.assistantMessages ?? 0}`} />
            <Row label="Tool calls" sub="results" value={`${stats?.toolCalls ?? 0} / ${stats?.toolResults ?? 0}`} />
          </div>

          <div className="border-t border-line/60 p-2">
            <button
              onClick={onCompact}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-fg hover:bg-inset"
            >
              <CompressIcon size={13} className="text-dim" />
              Compact conversation context
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
