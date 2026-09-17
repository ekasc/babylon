import { useMemo } from "react";
import type { ProjectGroup, SessionMeta, SessionStatus } from "../bridge";

interface Props {
  status: SessionStatus;
  groups: ProjectGroup[];
  onOpen(path: string | undefined, cwd: string): void;
  onNew(): void;
  /** Active project folder: shows the "What are we doing in X?" heading. */
  spaceCwd?: string | null;
}

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() || cwd;
}

function timeAgo(ms: number): string {
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function Hero({ status, groups, onOpen, onNew, spaceCwd = null }: Props) {
  const recent = useMemo(() => {
    const all: SessionMeta[] = [];
    for (const g of groups) for (const s of g.sessions) all.push(s);
    return all.sort((a, b) => b.mtime - a.mtime).slice(0, 6);
  }, [groups]);

  return (
    <div className="flex h-full flex-1 items-center justify-center overflow-y-auto px-8">
      <div className="w-full max-w-[520px]">
        {spaceCwd ? (
          <div className="text-center">
            <h2 className="m-0 text-[24px] font-semibold leading-[1.18] tracking-[-0.028em]">
              What are we doing in {projectName(spaceCwd)}?
            </h2>
            <p className="mt-2 text-[15px] leading-6 text-dim">
              Describe the change, question, or outcome you want.
            </p>
          </div>
        ) : null}
        {status.status === "starting" ? (
          <p className="mt-4 text-[13px] text-accent">Preparing Pi…</p>
        ) : null}
        {status.status === "error" ? (
          <p className="mt-4 text-[14px] leading-6 text-err">{status.message}</p>
        ) : null}
        {recent.length > 0 ? (
          <div className="mt-6">
            <p className="sidebar-section-label px-[10px]">Recent</p>
            <div className="mt-1">
              {recent.map((s) => {
                const title = s.name ?? s.firstUserText ?? s.id.slice(0, 8);
                return (
                  <button
                    key={s.path}
                    type="button"
                    onClick={() => onOpen(s.path, s.cwd)}
                    title={`${title} · ${projectName(s.cwd)}`}
                    className="sidebar-session"
                  >
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    <span className="sidebar-meta ml-auto shrink-0 tabular-nums">
                      {projectName(s.cwd)} · {timeAgo(s.mtime)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <button onClick={onNew} className="primary-button mt-6 px-5">
          New session
        </button>
        <p className="mt-3 text-[13px] text-dim">Press ⌘K to search sessions and commands.</p>
      </div>
    </div>
  );
}
