import { useEffect, useRef, useState } from "react";
import { formatElapsed, goalElapsed, type GoalPos, type GoalState } from "../lib/goal-mode";

const WIDTH = 300;
const MARGIN = 8;

function defaultPos(): GoalPos {
  const w = typeof window !== "undefined" ? window.innerWidth : 1280;
  const h = typeof window !== "undefined" ? window.innerHeight : 800;
  return { x: Math.max(MARGIN, w - WIDTH - 24), y: Math.max(MARGIN, h - 280) };
}

function clamp(pos: GoalPos): GoalPos {
  const w = typeof window !== "undefined" ? window.innerWidth : 1280;
  const h = typeof window !== "undefined" ? window.innerHeight : 800;
  return {
    x: Math.min(Math.max(MARGIN, pos.x), Math.max(MARGIN, w - WIDTH - MARGIN)),
    y: Math.min(Math.max(MARGIN, pos.y), Math.max(MARGIN, h - 140)),
  };
}

export function GoalOverlay({
  goal,
  onStart,
  onFinish,
  onClear,
  onClose,
  onMove,
}: {
  goal: GoalState | null;
  onStart(objective: string): void;
  onFinish(): void;
  onClear(): void;
  onClose(): void;
  onMove(pos: GoalPos): void;
}) {
  const [draft, setDraft] = useState("");
  const [pos, setPos] = useState<GoalPos>(() => clamp(goal?.pos ?? defaultPos()));
  const [now, setNow] = useState(() => Date.now());
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Live clock while a goal is open.
  useEffect(() => {
    if (!goal || goal.done) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [goal?.startedAt, goal?.done]);

  // Follow a newly loaded position (session switch, restart).
  useEffect(() => {
    if (goal?.pos) setPos(clamp(goal.pos));
  }, [goal?.startedAt]);

  useEffect(() => {
    if (!goal) inputRef.current?.focus();
  }, [goal === null]);

  const beginDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input")) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    const move = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const next = clamp({ x: ev.clientX - dragRef.current.dx, y: ev.clientY - dragRef.current.dy });
      setPos(next);
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

  const submit = () => {
    const clean = draft.trim();
    if (!clean) return;
    onStart(clean);
    setDraft("");
  };

  return (
    <div
      role="dialog"
      aria-label="Goal mode"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="fixed z-[70] w-[300px] overflow-hidden rounded-[var(--radius-lg)] border border-line bg-bg shadow-lg"
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        onPointerDown={beginDrag}
        className="flex cursor-grab items-center gap-2 border-b border-line/60 px-3 py-2 active:cursor-grabbing"
      >
        <span className="text-[11px] font-semibold tracking-[0.08em] uppercase text-dim">Goal</span>
        {goal && !goal.done ? <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-label="active" /> : null}
        <button type="button" onClick={onClose} aria-label="Close goal overlay" className="ml-auto rounded px-1 text-[13px] text-dim hover:text-fg">
          ×
        </button>
      </div>

      <div className="px-3 py-3">
        {!goal ? (
          <div>
            <p className="text-[13px] leading-5 text-dim">Name the objective. The clock starts and every assistant reply counts as one turn.</p>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="e.g. Fix the login redirect"
              aria-label="Goal objective"
              className="settings-input mt-2 w-full text-[13px]"
            />
            <div className="mt-2 flex justify-end">
              <button type="button" onClick={submit} disabled={!draft.trim()} className="context-button is-primary">
                Start goal
              </button>
            </div>
          </div>
        ) : goal.done ? (
          <div>
            <p className="truncate text-[13px] font-medium text-fg" title={goal.objective}>{goal.objective}</p>
            <p className="mt-1 text-[22px] leading-7 tabular-nums text-fg">{formatElapsed(goalElapsed(goal))}</p>
            <p className="mt-0.5 text-[12px] text-dim">{goal.turns} {goal.turns === 1 ? "turn" : "turns"} · done</p>
            <div className="mt-3 flex items-center gap-2">
              <button type="button" onClick={onClear} className="text-[12px] text-dim hover:text-fg">New goal</button>
              <button type="button" onClick={onClear} className="ml-auto text-[12px] text-dim hover:text-fg">Clear</button>
            </div>
          </div>
        ) : (
          <div>
            <p className="truncate text-[13px] font-medium text-fg" title={goal.objective}>{goal.objective}</p>
            <p className="mt-1 text-[22px] leading-7 tabular-nums text-fg">{formatElapsed(goalElapsed(goal, now))}</p>
            <p className="mt-0.5 text-[12px] text-dim">{goal.turns} {goal.turns === 1 ? "turn" : "turns"} so far</p>
            <div className="mt-3 flex items-center gap-2">
              <button type="button" onClick={onClear} className="text-[12px] text-dim hover:text-fg">Clear</button>
              <button type="button" onClick={onFinish} className="context-button is-primary ml-auto">Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
