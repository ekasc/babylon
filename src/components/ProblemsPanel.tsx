import { useMemo } from "react";
import type { LspProjectSnapshot, LspDiagnostic } from "../bridge";
import { useModalDialog } from "./useModalDialog";

function severityRank(s: LspDiagnostic["severity"]): number {
  if (s === "error") return 0;
  if (s === "warning") return 1;
  if (s === "info") return 2;
  return 3;
}

function groupBySeverity(diagnostics: LspDiagnostic[]): Array<[string, LspDiagnostic[]]> {
  const groups = new Map<string, LspDiagnostic[]>();
  for (const d of diagnostics) {
    const k = d.severity;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(d);
  }
  const ordered = ["error", "warning", "info", "hint"].filter((k) => groups.has(k));
  return ordered.map((k) => [k, groups.get(k)!]);
}

export function ProblemsPanel({
  snapshot,
  cwd,
  onRefresh,
  onClose,
}: {
  snapshot: LspProjectSnapshot | null;
  cwd?: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const dialogRef = useModalDialog(onClose);

  const groups = useMemo(() => {
    if (!snapshot || snapshot.diagnostics.length === 0) return [];
    const sorted = [...snapshot.diagnostics].sort((a, b) => {
      const ra = severityRank(a.severity);
      const rb = severityRank(b.severity);
      if (ra !== rb) return ra - rb;
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      if (a.line !== b.line) return a.line - b.line;
      return a.character - b.character;
    });
    return groupBySeverity(sorted);
  }, [snapshot]);

  const hasServers = snapshot ? snapshot.servers.length > 0 : false;

  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-[var(--scrim)] p-6" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="problems-title"
        className="modal-surface flex max-h-[80vh] w-full max-w-2xl flex-col p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="problems-title" className="text-[15px] font-semibold tracking-tight">
            Problems
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={onRefresh}
              title="Refresh diagnostics"
              className="rounded-lg border border-line px-2.5 py-1 text-[12.5px] hover:border-accent"
            >
              Refresh
            </button>
            <button onClick={onClose} className="rounded-lg border border-line px-2.5 py-1 text-[12.5px] hover:border-accent">
              Close
            </button>
          </div>
        </div>

        {cwd ? (
          <p className="mt-1 truncate text-[11.5px] text-dim" title={cwd}>
            {cwd}
          </p>
        ) : null}

        {/* Server states */}
        <div className="mt-3">
          {!snapshot ? (
            <p className="rounded-lg border border-line bg-raised/40 px-3 py-2 text-[12.5px] text-dim">
              No project selected. Open a session to see diagnostics.
            </p>
          ) : !hasServers ? (
            <p className="rounded-lg border border-line bg-raised/40 px-3 py-2 text-[12.5px] text-dim">
              No language server available for this project.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {snapshot.servers.map((s) => (
                <li key={s.language} className="flex items-center justify-between rounded-lg border border-line bg-raised/30 px-3 py-1.5 text-[12.5px]">
                  <span className="font-medium">{s.language}</span>
                  <span className="flex items-center gap-2">
                    <span className={`inline-block h-2 w-2 rounded-full ${s.status === "running" ? "bg-ok" : s.status === "starting" ? "bg-accent animate-pulse" : s.status === "crashed" ? "bg-err" : s.status === "unavailable" ? "bg-dim" : "bg-dim"}`} />
                    <span className="text-dim">{s.status}</span>
                    {s.pid ? <span className="font-mono text-dim">pid {s.pid}</span> : null}
                    {s.restartCount > 0 ? <span className="text-dim">restarts {s.restartCount}</span> : null}
                  </span>
                </li>
              ))}
              {snapshot.servers.some((s) => s.message) ? (
                <li className="overflow-hidden rounded-lg border border-line bg-raised/20 px-3 py-2 text-[11.5px] text-dim">
                  {snapshot.servers
                    .filter((s) => s.message)
                    .map((s) => (
                      <div key={s.language} className="truncate" title={s.message}>
                        {s.language}: {s.message}
                      </div>
                    ))}
                </li>
              ) : null}
            </ul>
          )}
        </div>

        {/* Diagnostics */}
        <div className="mt-4 min-h-0 flex-1 overflow-auto">
          {!snapshot ? null : snapshot.diagnostics.length === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-dim">No problems detected.</p>
          ) : (
            <div className="space-y-4">
              {groups.map(([severity, items]) => (
                <section key={severity}>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-dim">
                    {severity} ({items.length})
                  </h3>
                  <ul className="mt-1 space-y-1">
                    {items.map((d, i) => {
                      const rel = cwd ? toRelative(cwd, filePathFromUri(d.file)) : filePathFromUri(d.file);
                      return (
                        <li key={`${d.file}:${d.line}:${d.character}:${i}`} className="rounded-lg border border-line bg-raised/20 px-3 py-1.5 text-[12.5px]">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="font-mono text-[12px] text-dim">
                              {rel}:{d.line}:{d.character}
                            </span>
                            {d.source || d.code ? (
                              <span className="text-[11.5px] text-dim">
                                {d.source ? d.source : ""}
                                {d.source && d.code ? "/" : ""}
                                {d.code ? String(d.code) : ""}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-snug">{d.message}</div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>

        <p className="mt-3 text-[11px] text-dim">
          Updated {snapshot ? new Date(snapshot.updatedAt).toLocaleTimeString() : "—"}
        </p>
      </div>
    </div>
  );
}

function filePathFromUri(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === "file:") return decodeURIComponent(u.pathname);
  } catch {}
  return uri;
}

function toRelative(cwd: string, filePath: string): string {
  if (!filePath.startsWith("/")) return filePath;
  if (filePath === cwd) return ".";
  if (filePath.startsWith(cwd + "/")) return filePath.slice(cwd.length + 1);
  // Fallback: compute common prefix
  const cwdParts = cwd.split("/").filter(Boolean);
  const fileParts = filePath.split("/").filter(Boolean);
  let common = 0;
  while (common < cwdParts.length && common < fileParts.length && cwdParts[common] === fileParts[common]) common++;
  const up = cwdParts.length - common;
  const relParts = [...Array(up).fill(".."), ...fileParts.slice(common)];
  return relParts.join("/") || ".";
}
