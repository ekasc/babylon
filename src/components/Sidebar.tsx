import { memo, useMemo, useRef, useState } from "react";
import type { ProjectGroup, SessionMeta } from "../bridge";
import { ChevronIcon, FlaskIcon, PiMark, SearchIcon } from "./icons";

function timeAgo(ms: number): string {
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() || cwd;
}

interface Props {
  groups: ProjectGroup[];
  activePath?: string;
  activeCwd?: string;
  treeOpen: boolean;
  canOpenTree: boolean;
  onOpen(path: string | undefined, cwd: string, name?: string): void;
  onPrefetch?(path: string): void;
  onNew(): void;
  onNewSessionIn?(cwd: string): void;
  onDeleteSession?(path: string, name: string): void;
  onOpenFolder(): void;
  onOpenTree(): void;
  onSearch(): void;
}

export default function Sidebar({
  groups,
  activePath,
  activeCwd,
  treeOpen,
  canOpenTree,
  onOpen,
  onNew,
  onNewSessionIn,
  onDeleteSession,
  onOpenFolder,
  onOpenTree,
  onSearch,
  onPrefetch,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const orderedGroups = useMemo(
    () => groups.slice().sort((a, b) => {
      if (a.cwd === activeCwd) return -1;
      if (b.cwd === activeCwd) return 1;
      return (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0);
    }),
    [groups, activeCwd]
  );

  const toggleProject = (cwd: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  };

  return (
    <aside className="app-sidebar flex w-[272px] shrink-0 flex-col">
      <div className="titlebar flex h-16 shrink-0 items-center gap-2.5 px-4 pl-[76px]">
        <PiMark size={20} className="shrink-0 text-fg" />
        <span className="text-[16px] font-semibold tracking-[-0.02em]">Babylon</span>
      </div>

      <nav aria-label="Workspace" className="px-2.5">
        <button onClick={onNew} className="sidebar-action">
          <span className="sidebar-action-icon text-[20px] leading-none">＋</span>
          <span>New session</span>
        </button>
        <button onClick={onSearch} className="sidebar-action">
          <SearchIcon size={16} className="sidebar-action-icon" />
          <span>Search</span>
          <kbd className="ml-auto text-[12px] text-dim">⌘K</kbd>
        </button>
        <button
          onClick={onOpenTree}
          disabled={!canOpenTree}
          className={`sidebar-action ${treeOpen ? "is-active" : ""}`}
        >
          <span className="sidebar-action-icon text-[16px]">⑂</span>
          <span>History</span>
        </button>
      </nav>

      <div className="sidebar-section-label px-5 pb-2 pt-6">Projects</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
        {orderedGroups.length === 0 ? (
          <p className="px-3 py-3 text-[14px] leading-6 text-dim">Open a folder to start your first session.</p>
        ) : (
          orderedGroups.map((group) => {
            const isCollapsed = collapsed.has(group.cwd);
            return (
              <section key={group.cwd} className="mb-3">
                <div className="group/project flex items-center gap-0.5">
                  <button
                    onClick={() => toggleProject(group.cwd)}
                    className="sidebar-project flex-1"
                    title={group.cwd}
                    aria-expanded={!isCollapsed}
                  >
                    <ChevronIcon size={12} className={`sidebar-disclosure shrink-0 ${isCollapsed ? "" : "rotate-90"}`} />
                    <span className="truncate">{projectName(group.cwd)}</span>
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onNewSessionIn?.(group.cwd);
                    }}
                    title={`New chat in ${projectName(group.cwd)}`}
                    className="sidebar-project-add shrink-0"
                  >
                    ＋
                  </button>
                </div>
                {!isCollapsed ? (
                  <div className="sidebar-session-group ml-3 mt-0.5 border-l border-line/70 pl-1.5">
                    {group.sessions.length ? group.sessions.map((session) => (
                      <SessionRow
                        key={session.path}
                        session={session}
                        cwd={group.cwd}
                        active={activePath === session.path}
                        onOpen={onOpen}
                        onPrefetch={onPrefetch}
                        onDelete={onDeleteSession}
                      />
                    )) : <p className="px-3 py-2 text-[13px] text-dim">No sessions</p>}
                  </div>
                ) : null}
              </section>
            );
          })
        )}
        <button onClick={onOpenFolder} className="sidebar-action mt-1">
          <span className="sidebar-action-icon text-[14px] leading-none">📁</span>
          <span>Open folder…</span>
        </button>
      </div>

      <div className="sidebar-footer px-3 py-3 text-[13px] text-dim">
        <span>{activeCwd ? projectName(activeCwd) : "No project open"}</span>
      </div>
    </aside>
  );
}

const SessionRow = memo(function SessionRow({
  session,
  cwd,
  active,
  onOpen,
  onPrefetch,
  onDelete,
}: {
  session: SessionMeta;
  cwd: string;
  active: boolean;
  onOpen(path: string | undefined, cwd: string, name?: string): void;
  onPrefetch?(path: string): void;
  onDelete?(path: string, name: string): void;
}) {
  const title = session.name ?? session.firstUserText ?? session.id.slice(0, 8);
  // Hover intent: after 150ms of dwelling, warm the transcript into the cache
  // so a click is a synchronous swap with no serial fetch.
  const hoverTimer = useRef(0);
  const cancelPrefetch = () => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = 0;
    }
  };
  return (
    <button
      className={`sidebar-session group/session ${active ? "is-active" : ""}`}
      onClick={() => onOpen(session.path, cwd, title)}
      onMouseEnter={() => {
        if (!onPrefetch || active) return;
        cancelPrefetch();
        hoverTimer.current = window.setTimeout(() => onPrefetch(session.path), 150);
      }}
      onMouseLeave={cancelPrefetch}
      onFocus={() => {
        if (onPrefetch && !active) onPrefetch(session.path);
      }}
      title={`${title}\n${session.path}`}
    >
      <span className="min-w-0 flex-1 truncate">
        {session.isWorktree ? <FlaskIcon size={12} className="mr-1.5 inline text-warn" /> : null}
        {title}
      </span>
      <span className="shrink-0 text-[12px] tabular-nums text-dim">{timeAgo(session.mtime)}</span>
      {onDelete ? (
        <span
          role="button"
          tabIndex={0}
          aria-label={`Delete chat ${title}`}
          title="Delete chat"
          className="sidebar-session-delete"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(session.path, title);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onDelete(session.path, title);
            }
          }}
        >
          ✕
        </span>
      ) : null}
    </button>
  );
});
