import { useEffect, useMemo, useState } from "react";
import { bridge, type HistoryProjection, type HistoryTurn } from "../bridge";
import { BranchIcon, FlaskIcon, XIcon } from "./icons";

interface Props {
  onClose(): void;
  refreshToken: number;
  onRollback(entryId: string): void;
  onUndoRollback(): void;
  onForkCurrent(): void;
  toast(type: "info" | "warning" | "error", text: string): void;
}

export default function BranchPanel({ onClose, refreshToken, onRollback, onUndoRollback, onForkCurrent, toast }: Props) {
  const [history, setHistory] = useState<HistoryProjection>({ turns: [], leafId: null, hasBranches: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    bridge.getHistory()
      .then((value) => {
        if (!active) return;
        setHistory(value);
        setSelectedId((selected) => selected && value.turns.some((turn) => turn.entryId === selected) ? selected : null);
      })
      .catch((error) => toast("error", error?.message ?? "failed to load session history"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [refreshToken, toast]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selected = useMemo(
    () => history.turns.find((turn) => turn.entryId === selectedId) ?? null,
    [history.turns, selectedId]
  );

  return (
    <section aria-label="Session history workspace" className="context-pane flex h-full min-w-0 flex-col">
      <div className="context-header flex h-14 shrink-0 items-center gap-2 px-4">
        <BranchIcon size={14} className="shrink-0 text-accent" />
        <span className="text-[15px] font-semibold tracking-tight">History</span>
        <span className="truncate text-[13px] text-dim">
          {history.hasBranches ? "conversation branches" : "conversation timeline"}
        </span>
        <button onClick={onForkCurrent} className="context-header-button ml-auto" title="Fork the session from its current position">
          <FlaskIcon size={12} />
          Fork current
        </button>
        <button onClick={onClose} aria-label="Close history" className="context-icon-button">
          <XIcon size={12} />
        </button>
      </div>

      {history.activeRollback ? (
        <div className="history-rollback-status mx-3 mt-3">
          <div className="min-w-0 flex-1">
            <strong>{history.activeRollback.abandonedCount} turn{history.activeRollback.abandonedCount === 1 ? "" : "s"} rolled back</strong>
            <span>{history.activeRollback.fileCount} file{history.activeRollback.fileCount === 1 ? "" : "s"} restored</span>
          </div>
          <button
            onClick={onUndoRollback}
            disabled={!history.activeRollback.undoAvailable}
            title={history.activeRollback.undoReason}
            className="context-button"
          >
            Undo rollback
          </button>
        </div>
      ) : null}

      {selected ? <TurnDetail turn={selected} onRollback={onRollback} /> : null}

      <div className="context-content min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {loading ? (
          <p className="px-2 py-6 text-center text-[14px] text-dim">Loading history…</p>
        ) : history.turns.length === 0 ? (
          <p className="px-2 py-6 text-center text-[14px] text-dim">No user turns yet.</p>
        ) : (
          <HistoryRows
            turns={history.turns}
            branched={history.hasBranches}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
      </div>
    </section>
  );
}

function TurnDetail({ turn, onRollback }: { turn: HistoryTurn; onRollback(entryId: string): void }) {
  return (
    <div className="border-b border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-dim">Turn {turn.index}</span>
        {turn.current ? <span className="history-current-label">Current</span> : null}
        {!turn.onActivePath ? <span className="text-[12px] text-dim">Alternate path</span> : null}
      </div>
      <p className="mt-1 line-clamp-3 text-[14px] leading-5">{turn.text}</p>
      {turn.response ? <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-dim">{turn.response}</p> : null}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => onRollback(turn.entryId)}
          disabled={!turn.rollbackAvailable}
          title={turn.rollbackReason}
          className="context-button is-primary"
        >
          Rollback from here
        </button>
        {!turn.rollbackAvailable ? <span className="min-w-0 text-[12px] leading-4 text-dim">{turn.rollbackReason}</span> : null}
      </div>
    </div>
  );
}

function HistoryRows({ turns, branched, selectedId, onSelect }: { turns: HistoryTurn[]; branched: boolean; selectedId: string | null; onSelect(entryId: string): void }) {
  return (
    <div className="relative">
      {turns.map((turn) => {
        const indent = branched ? Math.min(turn.depth * 14, 154) : 0;
        return (
          <button
            key={turn.entryId}
            onClick={() => onSelect(turn.entryId)}
            className={`history-turn relative mb-1.5 flex w-full items-start gap-2 px-2.5 py-2.5 text-left ${turn.onActivePath ? "is-active-path" : ""} ${selectedId === turn.entryId ? "is-selected" : ""}`}
            style={{ marginLeft: indent, width: `calc(100% - ${indent}px)` }}
          >
            <span className={`history-node mt-1 ${turn.current ? "is-current" : turn.onActivePath ? "is-active" : ""}`} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="shrink-0 text-[12px] tabular-nums text-dim">{turn.index}</span>
                <span className="block truncate text-[14px] font-medium">{turn.text || "Untitled turn"}</span>
              </span>
              {turn.response ? <span className="mt-0.5 block truncate pl-5 text-[12px] leading-5 text-dim">{turn.response}</span> : null}
            </span>
            {turn.branchCount > 1 ? <span className="shrink-0 text-[12px] text-dim">{turn.branchCount} paths</span> : null}
            {turn.current ? <span className="history-current-label shrink-0">Current</span> : null}
          </button>
        );
      })}
    </div>
  );
}
