import { memo, useEffect, useState } from "react";
import { bridge, type HistoryTurn, type TurnFileChange, type TurnFileDiff } from "../bridge";
import { DiffView } from "./items";
import { ChevronIcon } from "./icons";

const AUTO_EXPAND_FILE_LIMIT = 5;

function kindLabel(kind: TurnFileChange["kind"]): string {
  return kind === "added" ? "A" : kind === "deleted" ? "D" : "M";
}

function kindClass(kind: TurnFileChange["kind"]): string {
  return kind === "added" ? "text-ok" : kind === "deleted" ? "text-err" : "text-accent";
}

function FileRow({ change, entryId }: { change: TurnFileChange; entryId: string }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<TurnFileDiff | null>(null);

  useEffect(() => {
    if (!open || diff) return;
    let cancelled = false;
    bridge
      .getTurnFileDiff(entryId, change.path)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, diff, entryId, change.path]);

  return (
    <div className="border-b border-line/60 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-inset/60"
      >
        <span className={`shrink-0 font-mono text-[11px] font-semibold ${kindClass(change.kind)}`}>
          {kindLabel(change.kind)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{change.path}</span>
        <span className="shrink-0 font-mono text-[12px] text-dim">
          <span className="text-ok">+{change.additions}</span>
          <span className="mx-1 text-line">/</span>
          <span className="text-err">-{change.deletions}</span>
        </span>
        <span className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`}>
          <ChevronIcon size={10} />
        </span>
      </button>
      {open && (
        <div className="ml-5 border-l border-line pl-3 pb-2">
          {diff ? (
            diff.diff.trim().length > 0 ? (
              <DiffView patch={diff.diff} />
            ) : (
              <p className="px-3 py-1 text-[13px] text-dim">No textual diff (binary or empty).</p>
            )
          ) : (
            <p className="px-3 py-1 text-[13px] text-dim">Loading diff…</p>
          )}
          {diff?.truncated ? (
            <p className="px-3 py-1 text-[12px] text-dim">Diff truncated.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export const TurnChanges = memo(function TurnChanges({ turn, isLatest }: { turn: HistoryTurn; isLatest: boolean }) {
  const changed = turn.changedCount > 0;
  const [open, setOpen] = useState(isLatest && changed && turn.changedCount <= AUTO_EXPAND_FILE_LIMIT);
  const [data, setData] = useState<{ files: TurnFileChange[]; totals: { files: number; additions: number; deletions: number }; exclusions: string[] } | null>(null);

  useEffect(() => {
    if (!open || data) return;
    let cancelled = false;
    bridge
      .getTurnChanges(turn.entryId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, data, turn.entryId]);

  const files = data?.files ?? [];
  const totals = data?.totals ?? { files: turn.changedCount, additions: 0, deletions: 0 };

  return (
    <div className="turn-changes">
      <button
        onClick={() => setOpen(!open)}
        className="turn-changes-row"
        aria-expanded={open}
      >
        <span className={`turn-changes-dot ${changed ? "is-on" : ""}`} aria-hidden />
        <span className="turn-changes-label font-mono">
          {changed ? `${totals.files} file${totals.files === 1 ? "" : "s"} changed` : "no changes"}
        </span>
        {changed ? (
          <span className="turn-changes-stats font-mono">
            <span className="text-ok">+{totals.additions}</span>
            <span className="text-err">−{totals.deletions}</span>
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        <span className={`turn-changes-chevron ${open ? "rotate-90" : ""}`}>
          <ChevronIcon size={10} />
        </span>
      </button>
      {open && (
        <div className="turn-changes-body">
          {files.length === 0 ? (
            <p className="px-3 py-2 font-mono text-[12px] text-dim">loading changes…</p>
          ) : (
            <>
              {files.map((change) => (
                <FileRow key={change.path} change={change} entryId={turn.entryId} />
              ))}
              {data?.exclusions.length ? (
                <p className="px-3 py-1.5 font-mono text-[11px] text-dim">{data.exclusions.join(" · ")}</p>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
});