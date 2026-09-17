import { useEffect, useRef, useState } from "react";
import { GaugeIcon } from "./icons";
import { fmtTokens } from "../store";
import { cacheHitRate, effectiveTps, type TokenUsage, type TurnSample } from "../lib/session-stats";

const WIDTH = 268;
const MARGIN = 8;

export interface StatsCardPos {
  x: number;
  y: number;
}

function clamp(pos: StatsCardPos): StatsCardPos {
  const w = typeof window !== "undefined" ? window.innerWidth : 1280;
  const h = typeof window !== "undefined" ? window.innerHeight : 800;
  return {
    x: Math.min(Math.max(MARGIN, pos.x), Math.max(MARGIN, w - WIDTH - MARGIN)),
    y: Math.min(Math.max(MARGIN, pos.y), Math.max(MARGIN, h - 180)),
  };
}

export function defaultStatsCardPos(): StatsCardPos {
  const h = typeof window !== "undefined" ? window.innerHeight : 800;
  return { x: 24, y: Math.max(MARGIN, h - 300) };
}

interface Props {
  tokens?: TokenUsage | null;
  totalMessages?: number;
  compactionCount: number;
  samples: TurnSample[];
  streaming?: boolean;
  initialPos: StatsCardPos;
  onMove(pos: StatsCardPos): void;
  onClose(): void;
}

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="text-[12px] text-dim">{label}</span>
      <span className="text-[12px] tabular-nums text-fg" title={title}>
        {value}
      </span>
    </div>
  );
}

/** Optional floating session telemetry. Shares the composer's surface so it
 *  reads as part of the same control language, and drags like the goal card. */
export default function StatsCard({
  tokens,
  totalMessages,
  compactionCount,
  samples,
  streaming = false,
  initialPos,
  onMove,
  onClose,
}: Props) {
  const [pos, setPos] = useState<StatsCardPos>(() => clamp(initialPos));
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    setPos(clamp(initialPos));
  }, [initialPos.x, initialPos.y]);

  const beginDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    const move = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      setPos(clamp({ x: ev.clientX - dragRef.current.dx, y: ev.clientY - dragRef.current.dy }));
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPos((p) => {
        onMove(p);
        return p;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const tps = effectiveTps(samples);
  const hit = cacheHitRate(tokens);

  return (
    <div
      role="dialog"
      aria-label="Session stats"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="composer-surface stats-card-surface fixed z-[70]"
      style={{ left: pos.x, top: pos.y, width: WIDTH }}
    >
      <div
        onPointerDown={beginDrag}
        className="flex cursor-grab items-center gap-2 border-b border-line/60 px-3 py-2 active:cursor-grabbing"
      >
        <GaugeIcon size={12} className="shrink-0 text-dim" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-dim">Session stats</span>
        {streaming ? <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-label="running" /> : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close session stats"
          className="ml-auto rounded px-1 text-[13px] text-dim hover:text-fg"
        >
          ×
        </button>
      </div>

      <div className="px-3 py-2">
        <Row label="Input tokens" value={fmtTokens(tokens?.input)} />
        <Row label="Output tokens" value={fmtTokens(tokens?.output)} />
        <Row label="Compactions" value={String(compactionCount)} />
        <Row
          label="TPS"
          value={tps != null ? tps.toFixed(1) : "—"}
          title="Output tokens per second, averaged over recent replies"
        />
        <Row
          label="Cache hit"
          value={hit != null ? `${Math.round(hit * 100)}%` : "—"}
          title="Cached prompt tokens ÷ (cache reads + fresh input + cache writes)"
        />
        <Row label="Messages" value={String(totalMessages ?? 0)} />
      </div>
    </div>
  );
}
