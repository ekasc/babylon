import { memo, useEffect, useState } from "react";
import { bridge, type HistoryTurn, type TurnFileChange, type TurnFileDiff } from "../bridge";
import { errorMessage } from "../lib/errors";
import { DiffView } from "./items";
import { ChevronIcon } from "./icons";

const AUTO_EXPAND_FILE_LIMIT = 5;

function kindLabel(kind: TurnFileChange["kind"]): string {
  return kind === "added" ? "A" : kind === "deleted" ? "D" : "M";
}

function kindClass(kind: TurnFileChange["kind"]): string {
  return kind === "added" ? "text-ok" : kind === "deleted" ? "text-err" : "text-accent";
}

function FileRow({ change, entryId, sessionFile }: { change: TurnFileChange; entryId: string; sessionFile: string | null }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<TurnFileDiff | null>(null);

  useEffect(() => {
    if (!open || diff || !sessionFile) return;
    let cancelled = false;
    bridge
      .getTurnFileDiff(sessionFile, entryId, change.path)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, diff, entryId, change.path, sessionFile]);

  return (
    <div className="border-b border-line/60 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-inset/60"
      >
        <span className={`shrink-0 text-[11px] font-semibold ${kindClass(change.kind)}`}>
          {kindLabel(change.kind)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px]">{change.path}</span>
        <span className="shrink-0 text-[12px] text-dim">
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

export const TurnChanges = memo(function TurnChanges({ turn, isLatest, sessionFile }: { turn: HistoryTurn; isLatest: boolean; sessionFile: string | null }) {
  const changed = turn.changedCount > 0;
  const [open, setOpen] = useState(isLatest && changed && turn.changedCount <= AUTO_EXPAND_FILE_LIMIT);
  const [data, setData] = useState<{ files: TurnFileChange[]; totals: { files: number; additions: number; deletions: number }; exclusions: string[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Totals must be truthful on the collapsed row too, so they load on mount:
  // only the per-file diffs stay lazy (each FileRow fetches its own on expand).
  // A failed load surfaces an error with a retry instead of spinning on
  // "loading changes…" forever: the fetch path (daemon socket, shadow
  // repo) can fail transiently while the checkpoint itself is fine.
  useEffect(() => {
    if (data || !sessionFile) return;
    let cancelled = false;
    setLoadError(null);
    bridge
      .getTurnChanges(sessionFile, turn.entryId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err, "couldn't load changes"));
      });
    return () => {
      cancelled = true;
    };
  }, [data, turn.entryId, attempt, sessionFile ]);

  const files = data?.files ?? [];
  const totals = data?.totals ?? { files: turn.changedCount, additions: 0, deletions: 0 };

  // The absence of the changes surface is the empty state: zero changed
  // files renders nothing, never a "no changes" row.
  if (!changed) return null;

  return (
    <div className="turn-changes">
      <button
        onClick={() => setOpen(!open)}
        className="turn-changes-row"
        aria-expanded={open}
      >
        <span className="turn-changes-dot is-on" aria-hidden />
        <span className="turn-changes-label">
          {`${totals.files} file${totals.files === 1 ? "" : "s"} changed`}
        </span>
        {data ? (
          <span className="turn-changes-stats">
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
          {loadError ? (
            <div className="flex items-center gap-2 px-3 py-2">
              <p className="min-w-0 flex-1 truncate text-[12px] text-err" title={loadError}>{loadError}</p>
              <button
                onClick={() => setAttempt((n) => n + 1)}
                aria-label="Retry loading changes"
                className="shrink-0 rounded-full border border-line px-3 py-1 text-[12px] text-dim hover:border-accent/30 hover:text-accent"
              >
                Retry
              </button>
            </div>
          ) : files.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-dim">loading changes…</p>
          ) : (
            <>
              {files.map((change) => (
                <FileRow key={change.path} change={change} entryId={turn.entryId} sessionFile={sessionFile} />
              ))}
              {data?.exclusions.length ? (
                <p className="px-3 py-1.5 text-[11px] text-dim">{data.exclusions.join(" · ")}</p>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
});