import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GitStatusResult, ProjectGroup, SessionMeta } from "../bridge";
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BlockedIcon,
  BranchIcon,
  ChatIcon,
  ChevronIcon,
  ClockIcon,
  FlaskIcon,
  FolderIcon,
  GearIcon,
  InputIcon,
  PiMark,
  PlusIcon,
  RunningIcon,
  SearchIcon,
} from "./icons";
import ProjectFilter from "./ProjectFilter";
import { projectColor } from "../lib/colors";
import { projectColorEffect } from "../lib/colors.effect";
import * as Effect from "effect/Effect";
import { promptText } from "../lib/prompts";

/* ------------------------------------------------------------------ *
 * Icons (t3code-style glyphs)                                          *
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */
type Section = "pinned" | "active" | "snoozed" | "archived";

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

interface SnoozePreset {
  id: string;
  label: string;
  until: number;
}
function buildSnoozePresets(now: number): SnoozePreset[] {
  const atTime = (d: Date, h: number, m = 0) => {
    const x = new Date(d);
    x.setHours(h, m, 0, 0);
    return x.getTime();
  };
  const addDays = (d: Date, n: number) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  const nextWeekday = (d: Date, wd: number) => {
    const x = new Date(d);
    const delta = (wd - x.getDay() + 7) % 7 || 7;
    x.setDate(x.getDate() + delta);
    return x;
  };
  return [
    { id: "later", label: "Later today", until: now + 3 * 3600_000 },
    { id: "tomorrow", label: "Tomorrow", until: atTime(addDays(new Date(now), 1), 9) },
    { id: "week", label: "Next week", until: atTime(nextWeekday(new Date(now), 1), 9) },
    { id: "month", label: "Next month", until: atTime(addDays(new Date(now), 30), 9) },
  ];
}
function snoozeLabel(until: number, now: number): string {
  const d = new Date(until);
  const today = new Date(now);
  const tomorrow = new Date(now + 86400_000);
  if (d.toDateString() === today.toDateString())
    return `Snoozed until ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  if (d.toDateString() === tomorrow.toDateString()) return "Snoozed until tomorrow";
  return `Snoozed until ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/* ------------------------------------------------------------------ *
 * Context menu (1:1 with t3code's thread action menu)                  *
 * ------------------------------------------------------------------ */
function ThreadMenu(props: {
  x: number;
  y: number;
  session: SessionMeta;
  pinned: boolean;
  snoozedUntil: number | undefined;
  unread: boolean;
  archived: boolean;
  onClose(): void;
  onTogglePin(path: string): void;
  onToggleSnooze(path: string, until?: number): void;
  onToggleUnread(path: string): void;
  onToggleArchive(path: string): void;
  onRename(path: string): void;
  onCopy(kind: "path" | "id" | "branch", session: SessionMeta): void;
  onDelete(path: string, name: string): void;
  onCreateHandoff?(path: string): void;
  onConsumeHandoff?(path: string): void;
}) {
  const { session, pinned, snoozedUntil, unread, archived, onClose } = props;
  const isSnoozed = snoozedUntil != null && snoozedUntil > Date.now();
  const [sub, setSub] = useState<"snooze" | "copy" | null>(null);
  const presets = useMemo(() => buildSnoozePresets(Date.now()), []);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("button")?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
        if (!items.length) return;
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
        items[index === -1 ? (e.key === "ArrowDown" ? 0 : items.length - 1) : next]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden="true" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={menuRef}
        role="menu"
        aria-label={`Chat actions for ${session.name ?? session.id}`}
        className="thread-menu fixed z-50"
        style={{ top: Math.min(props.y, window.innerHeight - 360), left: Math.min(props.x, window.innerWidth - 210) }}
      >
        {archived ? (
          <>
            <button role="menuitem" className="thread-menu-item" onClick={() => { props.onToggleArchive(session.path); onClose(); }}>Unarchive chat</button>
            <button role="menuitem" className="thread-menu-item danger" onClick={() => { props.onDelete(session.path, session.name ?? session.firstUserText ?? session.id); onClose(); }}>Delete chat</button>
          </>
        ) : (
          <>
            <button role="menuitem" className="thread-menu-item" onClick={() => { props.onTogglePin(session.path); onClose(); }}>{pinned ? "Unpin chat" : "Pin chat"}</button>
            {isSnoozed ? (
              <button role="menuitem" className="thread-menu-item" onClick={() => { props.onToggleSnooze(session.path); onClose(); }}>Wake chat</button>
            ) : (
              <div className="relative" onMouseEnter={() => setSub("snooze")} onMouseLeave={() => setSub(null)}>
                <button role="menuitem" aria-haspopup="true" aria-expanded={sub === "snooze"} className="thread-menu-item" onClick={() => setSub((s) => (s === "snooze" ? null : "snooze"))}>
                  <span>Snooze</span><span className="text-dim">›</span>
                </button>
                {sub === "snooze" && (
                  <div role="menu" aria-label="Snooze presets" className="thread-menu-sub">
                    {presets.map((p) => (
                      <button key={p.id} role="menuitem" className="thread-menu-item" onClick={() => { props.onToggleSnooze(session.path, p.until); onClose(); }}>{p.label}</button>
                    ))}
                    <button role="menuitem" className="thread-menu-item" onClick={async () => {
                      const v = await promptText({ title: "Snooze until", message: "e.g. 2025-03-10 09:00 or +2h", placeholder: "2025-03-10 09:00" });
                      if (!v) return onClose();
                      let until = Number.NaN;
                      if (v.startsWith("+")) until = Date.now() + (parseFloat(v.slice(1)) * (v.includes("h") ? 3600_000 : v.includes("d") ? 86400_000 : 60_000));
                      else until = Date.parse(v);
                      if (Number.isNaN(until)) return onClose();
                      props.onToggleSnooze(session.path, until); onClose();
                    }}>Pick a time…</button>
                  </div>
                )}
              </div>
            )}
            <div className="thread-menu-sep" />
            <button role="menuitem" className="thread-menu-item" onClick={() => { props.onRename(session.path); onClose(); }}>Rename chat</button>
            <button role="menuitem" className="thread-menu-item" onClick={() => { props.onToggleUnread(session.path); onClose(); }}>{unread ? "Mark read" : "Mark unread"}</button>
            <div className="relative" onMouseEnter={() => setSub("copy")} onMouseLeave={() => setSub(null)}>
              <button role="menuitem" aria-haspopup="true" aria-expanded={sub === "copy"} className="thread-menu-item" onClick={() => setSub((s) => (s === "copy" ? null : "copy"))}>
                <span>Copy</span><span className="text-dim">›</span>
              </button>
              {sub === "copy" && (
                <div role="menu" aria-label="Copy options" className="thread-menu-sub">
                  <button role="menuitem" className="thread-menu-item" onClick={() => { props.onCopy("path", session); onClose(); }}>Path</button>
                  <button role="menuitem" className="thread-menu-item" onClick={() => { props.onCopy("id", session); onClose(); }}>Chat ID</button>
                  {session.isWorktree && <button role="menuitem" className="thread-menu-item" onClick={() => { props.onCopy("branch", session); onClose(); }}>Branch</button>}
                </div>
              )}
            </div>
            {props.onCreateHandoff || props.onConsumeHandoff ? <div className="thread-menu-sep" /> : null}
            {props.onCreateHandoff ? (
              <button role="menuitem" className="thread-menu-item" onClick={() => { props.onCreateHandoff?.(session.path); onClose(); }}>Create handoff…</button>
            ) : null}
            {props.onConsumeHandoff ? (
              <button role="menuitem" className="thread-menu-item" onClick={() => { props.onConsumeHandoff?.(session.path); onClose(); }}>Consume latest handoff</button>
            ) : null}
            <div className="thread-menu-sep" />
            <button role="menuitem" className="thread-menu-item" onClick={() => { props.onToggleArchive(session.path); onClose(); }}>Archive chat</button>
            <button role="menuitem" className="thread-menu-item danger" onClick={() => { props.onDelete(session.path, session.name ?? session.firstUserText ?? session.id); onClose(); }}>Delete chat</button>
          </>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Session row                                                         *
 * ------------------------------------------------------------------ */
interface RowProps {
  session: SessionMeta;
  cwd: string;
  section: Section;
  active: boolean;
  pinned: boolean;
  /** Grouped mode: project header already shows the project, so the row skips its project line. */
  hideProject?: boolean;
  snoozedUntil: number | undefined;
  unread: boolean;
  archived: boolean;
  streaming: boolean;
  agentStatus: "running" | "blocked" | "needs-input" | "done";
  branch?: string;
  gitStatus?: GitStatusResult | null;
  onRefreshGitStatus?: () => void;
  onOpen(path: string | undefined, cwd: string, name?: string): void;
  onPrefetch?(path: string): void;
  onDelete?(path: string, name: string): void;
  onTogglePin(path: string): void;
  onToggleSnooze(path: string, until?: number): void;
  onToggleUnread(path: string): void;
  onToggleArchive(path: string): void;
  onRename(path: string): void;
  onCopy(kind: "path" | "id" | "branch", session: SessionMeta): void;
  onCreateHandoff?(path: string): void;
  onConsumeHandoff?(path: string): void;
}

/** Live agent for the Agents dock (herdr-style): jump to it or stop it. */
export interface AgentDockItem {
  kind: "thread" | "subagent" | "workflow";
  id: string;
  label: string;
  status: "running" | "blocked" | "needs-input";
  sessionPath?: string | null;
  cwd?: string;
}

// Git status meta: only commit divergence (ahead / behind), each colored by meaning.
function GitStatusMeta({ g }: { g: GitStatusResult }) {
  return (
    <>
      {g.ahead > 0 && (
        <span className="git-ahead flex shrink-0 items-center gap-0.5 tabular-nums">
          <ArrowUpIcon size={11} />
          {g.ahead}
        </span>
      )}
      {g.behind > 0 && (
        <span className="git-behind flex shrink-0 items-center gap-0.5 tabular-nums">
          <ArrowDownIcon size={11} />
          {g.behind}
        </span>
      )}
      {g.isWorktree && (
        <span className="git-worktree flex shrink-0 items-center gap-0.5">
          <FlaskIcon size={11} />
          worktree
        </span>
      )}
    </>
  );
}

function gitStatusTooltip(g: GitStatusResult): string {
  if (!g.isRepo) return "not a git repository";
  const lines = [`Branch: ${g.branch ?? "?"}`];
  if (g.isWorktree) lines.push("Worktree");
  if (g.dirty.length) {
    lines.push(`Changes (${g.dirty.length}):`);
    for (const f of g.dirty.slice(0, 50)) lines.push(`  ${f.status} ${f.path}`);
    if (g.dirty.length > 50) lines.push(`  …and ${g.dirty.length - 50} more`);
  } else {
    lines.push("Working tree clean");
  }
  if (g.ahead || g.behind) lines.push(`Ahead ${g.ahead} / Behind ${g.behind}`);
  return lines.join("\n");
}

const SessionRow = memo(function SessionRow(props: RowProps) {
  const { session, cwd, section, active, pinned, snoozedUntil, unread, archived, streaming, agentStatus, branch, gitStatus, onRefreshGitStatus } = props;
  const title = session.name ?? session.firstUserText ?? session.id.slice(0, 8);
  const hoverTimer = useRef(0);
  const cancelPrefetch = () => { if (hoverTimer.current) { window.clearTimeout(hoverTimer.current); hoverTimer.current = 0; } };
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const isSnoozed = snoozedUntil != null && snoozedUntil > Date.now();
  const timeLabel = isSnoozed && snoozedUntil != null ? snoozeLabel(snoozedUntil, Date.now()) : timeAgo(session.mtime);

  const slim = section === "snoozed";
  const pc = Effect.runSync(projectColorEffect(cwd));
  const rowClass =
    `sidebar-session group/session ${active ? "is-active" : ""} ${archived ? "opacity-50" : ""} ${slim ? "is-slim" : ""}`;

  const effectiveBranch = gitStatus?.branch ?? branch;
  const gitTip = gitStatus?.isRepo ? gitStatusTooltip(gitStatus) : undefined;
  // Single status badge shared by both layouts; absent when idle so quiet
  // rows stay quiet and running/blocked rows stand out.
  const statusBadge = agentStatus !== "done" ? (
    <span className={`session-status ml-auto ${agentStatus}`}>
      {agentStatus === "running" && <RunningIcon size={11} />}
      {agentStatus === "blocked" && <BlockedIcon size={11} />}
      {agentStatus === "needs-input" && <InputIcon size={11} />}
      {agentStatus === "needs-input" ? "needs input" : agentStatus}
    </span>
  ) : null;
  // Always render the third line so every non-slim row is the same height
  // (no reflow when the active row changes or git data loads).
  const branchNode = (
    <span className="sidebar-branch sidebar-meta flex min-w-0 items-center gap-1.5" title={gitTip}>
      {gitStatus?.isRepo ? (
        <>
          <BranchIcon size={12} className="shrink-0 text-[var(--git)]" />
          {effectiveBranch && <span className="min-w-0 truncate">{effectiveBranch}</span>}
          <GitStatusMeta g={gitStatus} />
        </>
      ) : effectiveBranch ? (
        <>
          <BranchIcon size={12} className="shrink-0 text-[var(--git)]" />
          <span className="min-w-0 truncate">{effectiveBranch}</span>
        </>
      ) : (
        <span className="truncate"> </span>
      )}
    </span>
  );

  const rowStyle = { ["--pc" as string]: pc } as React.CSSProperties;
  // Tabs render the button itself as the row: no wrapper container, no
  // active-state box. The active tab reads via text color, not background.
  const buttonClass = props.hideProject
    ? `min-w-0 flex-1 rounded-md px-2 py-1 text-left ${active ? "text-fg" : "text-dim"} hover:text-fg`
    : "flex min-w-0 flex-1 items-center gap-2 text-left";
  const menuPortal = menu &&
    createPortal(
      <ThreadMenu
        x={menu.x}
        y={menu.y}
        session={session}
        pinned={pinned}
        snoozedUntil={snoozedUntil}
        unread={unread}
        archived={archived}
        onClose={() => setMenu(null)}
        onTogglePin={props.onTogglePin}
        onToggleSnooze={props.onToggleSnooze}
        onToggleUnread={props.onToggleUnread}
        onToggleArchive={props.onToggleArchive}
        onRename={props.onRename}
        onCopy={props.onCopy}
        onCreateHandoff={props.onCreateHandoff}
        onConsumeHandoff={props.onConsumeHandoff}
        onDelete={props.onDelete ?? (() => {})}
      />,
      document.body
    );
  const content = slim ? (
    <>
      <span className="shrink-0 text-dim">{isSnoozed ? <ClockIcon size={15} /> : <ChatIcon size={15} />}</span>
      <span className="min-w-0 flex-1 truncate text-dim">{isSnoozed ? timeLabel : title}</span>
      {gitStatus?.isRepo && <GitStatusMeta g={gitStatus} />}
      <span className="sidebar-meta shrink-0 w-12 text-right tabular-nums">{isSnoozed ? "" : timeAgo(session.mtime)}</span>
    </>
  ) : props.hideProject ? (
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {unread && <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--pc)] align-middle" />}
        {streaming && <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--ok)] align-middle" />}
        <span className="truncate text-[13px] leading-snug">{title}</span>
        <span className="sidebar-meta ml-auto shrink-0 tabular-nums">{timeAgo(session.mtime)}</span>
      </span>
    </span>
  ) : (
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {session.isWorktree ? <FlaskIcon size={13} className="shrink-0 text-warn" /> : <FolderIcon size={13} className="shrink-0 text-dim" />}

        <span className="sidebar-project-name sidebar-meta truncate">{projectName(cwd)}</span>
        {statusBadge}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {unread && <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--pc)] align-middle" />}
        {streaming && <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--ok)] align-middle" />}
        <span className="truncate text-fg text-[14px] leading-snug">{title}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {branchNode}
        <span className="sidebar-meta ml-auto shrink-0 tabular-nums">{timeAgo(session.mtime)}</span>
      </span>
    </span>
  );
  const button = (
    <button
      className={buttonClass}
      style={props.hideProject ? rowStyle : undefined}
      draggable={false}
      onClick={() => props.onOpen(session.path, cwd, title)}
      onMouseEnter={() => {
        onRefreshGitStatus?.();
        if (!props.onPrefetch || active) return;
        cancelPrefetch();
        hoverTimer.current = window.setTimeout(() => props.onPrefetch?.(session.path), 150);
      }}
      onMouseLeave={() => { cancelPrefetch(); }}
      onFocus={() => { if (props.onPrefetch && !active) props.onPrefetch(session.path); }}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      title={`${title}\n${session.path}${effectiveBranch ? `\n${effectiveBranch}` : ""}`}
    >
      {content}
    </button>
  );
  if (props.hideProject) {
    // Tabs render the button itself as the row: no wrapper container.
    return (
      <>
        {button}
        {menuPortal}
      </>
    );
  }
  return (
    <div
      className={rowClass}
      style={rowStyle}
    >
      {button}
      {menuPortal}
    </div>
  );
});
/* ------------------------------------------------------------------ *
 * Sidebar (flat Pinned → Active → Snoozed) *
 * ------------------------------------------------------------------ */
interface Props {
  groups: ProjectGroup[];
  activePath?: string;
  activeCwd?: string;
  activeStreaming?: boolean;
  treeOpen: boolean;
  canOpenTree: boolean;
  minimized: boolean;
  onToggleMinimize(): void;
  onOpenSettings(): void;
  onOpen(path: string | undefined, cwd: string, name?: string): void;
  onPrefetch?: (path: string) => void;
  onNew(): void;
  onNewSessionIn?(cwd: string): void;
  projectFilter: string;
  onProjectFilterChange(filter: string): void;
  onDeleteSession?(path: string, name: string): void;
  onOpenFolder(): void;
  onOpenTree(): void;
  onSearch(): void;
  // t3code-style state (client-persisted)
  pinnedOrder: string[];
  snoozed: Record<string, number>;
  archived: string[];
  unread: string[];
  onTogglePin(path: string): void;
  onToggleSnooze(path: string, until?: number): void;
  onToggleUnread(path: string): void;
  onToggleArchive(path: string): void;
  onRename(path: string): void;
  onCopy(kind: "path" | "id" | "branch", session: SessionMeta): void;
  onCreateHandoff?(path: string): void;
  onConsumeHandoff?(path: string): void;
  showArchived: boolean;
  onToggleShowArchived(): void;
  agentState?: "running" | "blocked" | "needs-input" | "done";
  /** Per-session liveness keyed by session path. Falls back to agentState/activeStreaming when absent. */
  sessionStatus?: Record<string, { streaming: boolean; agentStatus: "running" | "blocked" | "needs-input" | "done" }>;
  /** Live agents dock (herdr-style): threads/subagents/workflows to jump to or stop. */
  agents?: AgentDockItem[];
  onOpenAgent?(agent: AgentDockItem): void;
  onStopAgent?(agent: AgentDockItem): void;
  /** User-curated space folders. The session index is never auto-imported. */
  spaceCwds: string[];
  onAddSpace(): void;
  onRemoveSpace(cwd: string): void;
  /** Explicitly opened tabs per space. Stay open until closed. */
  openTabs: Record<string, string[]>;
  onCloseTab(cwd: string, path: string): void;
  activeBranch?: string;
  gitStatuses?: Record<string, GitStatusResult>;
  onRefreshGitStatus?: (cwd: string) => void;
}

export default function Sidebar(props: Props) {
  const {
    groups, activePath, activeCwd, activeStreaming,
    treeOpen, canOpenTree, minimized, onToggleMinimize, onOpenSettings,
    onOpen, onPrefetch, onNew, onNewSessionIn, onDeleteSession,
    onOpenFolder, onOpenTree, onSearch,
    projectFilter, onProjectFilterChange,
    pinnedOrder, snoozed, archived, unread,
    onTogglePin, onToggleSnooze, onToggleUnread, onToggleArchive, onRename, onCopy,
    onCreateHandoff, onConsumeHandoff,
    agentState, sessionStatus, agents, onOpenAgent, onStopAgent, spaceCwds, onAddSpace, onRemoveSpace, openTabs, onCloseTab, activeBranch, gitStatuses, onRefreshGitStatus,
    showArchived, onToggleShowArchived,
  } = props;

  const [snoozedExpanded, setSnoozedExpanded] = useState(true);


  const [width, setWidth] = useState(() => {
    const w = Number(localStorage.getItem("babylon:sidebar-width"));
    return w >= 220 && w <= 560 ? w : 300;
  });
  const widthRef = useRef(width);
  widthRef.current = width;
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    document.body.classList.add("sidebar-resizing");
    const onMove = (ev: MouseEvent) =>
      setWidth(Math.min(560, Math.max(220, startW + (ev.clientX - startX))));
    const onUp = () => {
      document.body.classList.remove("sidebar-resizing");
      localStorage.setItem("babylon:sidebar-width", String(widthRef.current));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const pinnedSet = useMemo(() => new Set(pinnedOrder), [pinnedOrder]);
  const archivedSet = useMemo(() => new Set(archived), [archived]);
  const unreadSet = useMemo(() => new Set(unread), [unread]);

  const flat = useMemo(
    () => groups.flatMap((g) => g.sessions.map((s) => ({ session: s, cwd: g.cwd }))),
    [groups]
  );
  const now = Date.now();
  const classify = (path: string): Section => {
    if (archivedSet.has(path)) return "archived";
    if (pinnedSet.has(path)) return "pinned";
    const su = snoozed[path];
    if (su != null && su > now) return "snoozed";
    return "active";
  };

  const isSnoozedPath = (path: string) => snoozed[path] != null && snoozed[path] > now;
  const snoozedList = useMemo(
    () => flat.filter(({ session }) => classify(session.path) === "snoozed").sort((a, b) => (snoozed[a.session.path] ?? 0) - (snoozed[b.session.path] ?? 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flat, pinnedSet, snoozed, archivedSet]
  );
  const archivedList = useMemo(
    () => flat.filter(({ session }) => archivedSet.has(session.path)).sort((a, b) => b.session.mtime - a.session.mtime),
    [flat, archivedSet]
  );
  // Spaces (herdr): user-curated only, never auto-imported from the session
  // index. The active project always shows (transiently) so you see where
  // you are; everything else appears only after you add it. Counts exclude
  // archived and snoozed sessions; resume lives in Search.
  const spaces = useMemo(() => {
    const cwds = [...spaceCwds];
    if (activeCwd && !cwds.includes(activeCwd)) cwds.unshift(activeCwd);
    const byCwd = new Map(groups.map((g) => [g.cwd, g.sessions]));
    const rows = cwds.map((cwd) => {
      const sessions = [...(byCwd.get(cwd) ?? [])].sort((a, b) => b.mtime - a.mtime);
      const usable = sessions.filter((s) => !archivedSet.has(s.path) && !isSnoozedPath(s.path));
      const live = usable.filter((s) => sessionStatus?.[s.path]?.agentStatus === "running").length;
      return { cwd, usable, live, latest: usable[0]?.mtime ?? 0 };
    });
    return rows.sort((a, b) => {
      if (a.cwd === activeCwd) return -1;
      if (b.cwd === activeCwd) return 1;
      return b.latest - a.latest;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, archivedSet, snoozed, sessionStatus, activeCwd, spaceCwds]);
  // Tabs of the active space (herdr): explicitly opened views that stay open
  // until you close them. Opening any session adds it; pinned sessions are
  // permanent tabs; the active session always shows (transiently) even with
  // its tab closed. Nothing auto-fills from recency.
  const tabs = useMemo(() => {
    if (!activeCwd) return [];
    const byPath = new Map(flat.map((e) => [e.session.path, e]));
    const ids = [...(openTabs[activeCwd] ?? [])];
    for (const p of pinnedOrder) if (!ids.includes(p)) ids.push(p);
    if (activePath && !ids.includes(activePath)) ids.push(activePath);
    const out: { session: SessionMeta; cwd: string }[] = [];
    for (const p of ids) {
      const e = byPath.get(p);
      if (!e || e.cwd !== activeCwd || archivedSet.has(p) || isSnoozedPath(p)) continue;
      if (!out.some((x) => x.session.path === p)) out.push(e);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, activeCwd, activePath, archivedSet, snoozed, pinnedOrder, openTabs]);

  // Switching spaces opens the space's most recent open tab, else its most
  // recent session as a tab (herdr: switching workspaces changes the entire
  // context). Empty spaces start a fresh tab.
  const openSpace = (cwd: string, usable: SessionMeta[]) => {
    const tabsHere = (openTabs[cwd] ?? []).filter((p) => usable.some((s) => s.path === p));
    const target = tabsHere[tabsHere.length - 1] ?? usable[0]?.path;
    const meta = usable.find((s) => s.path === target);
    if (meta) onOpen(meta.path, cwd);
    else if (onNewSessionIn) void onNewSessionIn(cwd);
    else onNew();
  };

  if (minimized) {
    // The expand control lives in the thread header (App.tsx) so it never
    // collides with the macOS traffic lights' click region.
    return null;
  }

  const renderRow = (entry: { session: SessionMeta; cwd: string }, section: Section, hideProject = false) => {
    const active = activePath === entry.session.path;
    const live = sessionStatus?.[entry.session.path];
    return (
    <SessionRow
      key={`${entry.session.path}:${section}`}
      session={entry.session}
      cwd={entry.cwd}
      section={section}
      active={activePath === entry.session.path}
      pinned={section === "pinned"}
      hideProject={hideProject}
      snoozedUntil={snoozed[entry.session.path]}
      unread={unreadSet.has(entry.session.path)}
      archived={archivedSet.has(entry.session.path)}
      streaming={live?.streaming ?? (activePath === entry.session.path && !!activeStreaming)}
      agentStatus={live?.agentStatus ?? agentState ?? "done"}
      branch={activePath === entry.session.path ? activeBranch : undefined}
      gitStatus={gitStatuses?.[entry.cwd] ?? null}
      onRefreshGitStatus={gitStatuses?.[entry.cwd] ? () => onRefreshGitStatus?.(entry.cwd) : undefined}
      onOpen={onOpen}
      onPrefetch={onPrefetch}
      onDelete={onDeleteSession}
      onTogglePin={onTogglePin}
      onToggleSnooze={onToggleSnooze}
      onToggleUnread={onToggleUnread}
      onToggleArchive={onToggleArchive}
      onRename={onRename}
      onCopy={onCopy}
      onCreateHandoff={onCreateHandoff}
      onConsumeHandoff={onConsumeHandoff}
    />
    );
  }

  return (
    <aside className="app-sidebar flex shrink-0 flex-col" style={{ width }}>
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={width}
        aria-valuemin={220}
        aria-valuemax={560}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          setWidth((w) => {
            const next = Math.min(560, Math.max(220, w + (e.key === "ArrowRight" ? 16 : -16)));
            localStorage.setItem("babylon:sidebar-width", String(next));
            return next;
          });
        }}
        onMouseDown={startResize}
      />
      <div className="titlebar flex h-11 shrink-0 items-center gap-2 pl-[88px] pr-3">
        {spaces.length > 1 ? (
          <div className="min-w-0 flex-1">
            <ProjectFilter
              projects={spaces.map((sp) => ({ cwd: sp.cwd, name: projectName(sp.cwd) }))}
              value={projectFilter}
              onChange={onProjectFilterChange}
            />
          </div>
        ) : (
          <>
            <PiMark size={20} className="shrink-0 text-fg" />
            <span className="text-[16px] font-semibold tracking-[-0.02em]">Babylon</span>
          </>
        )}
        <button onClick={onToggleMinimize} title="Minimize sidebar (⌘B)" aria-label="Minimize sidebar" className="sidebar-toggle ml-auto shrink-0">
          <ChevronIcon size={14} className="rotate-180" />
        </button>
      </div>

      <nav aria-label="Workspace" className="px-2.5">
        <button onClick={onNew} className="sidebar-action">
          <PlusIcon size={16} className="sidebar-action-icon" />
          <span>New tab</span>
        </button>
        <button onClick={onSearch} className="sidebar-action">
          <SearchIcon size={16} className="sidebar-action-icon" />
          <span>Search</span>
          <kbd className="ml-auto text-[12px] text-dim">⌘K</kbd>
        </button>
        <button onClick={onOpenTree} disabled={!canOpenTree} className={`sidebar-action ${treeOpen ? "is-active" : ""}`}>
          <BranchIcon size={16} className="sidebar-action-icon" />
          <span>History</span>
        </button>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {spaces.length === 0 ? (
          <div className="px-3 py-3">
            <p className="text-[14px] leading-6 text-dim">No spaces yet. Add a project to start.</p>
            <button type="button" onClick={onAddSpace} className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg hover:opacity-90">
              Add a space
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1 px-2.5 pb-1 pt-1">
              <span className="shelf-label">Spaces{spaces.length > 0 ? ` (${spaces.length})` : ""}</span>
              <span className="shelf-divider" />
              <button type="button" onClick={onAddSpace} title="Add a space (pick a project folder)" className="thread-action thread-action-text text-[12px]">
                Add
              </button>
            </div>
            {spaces.map((sp) => {
              const isActiveSpace = sp.cwd === activeCwd;
              const pc = Effect.runSync(projectColorEffect(sp.cwd));
              const branch = gitStatuses?.[sp.cwd]?.branch;
              return (
                <div key={sp.cwd}>
                  <div className={`group/space flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 ${isActiveSpace ? "bg-accent/10" : "hover:bg-raised"}`}>
                  <button
                    type="button"
                    onClick={() => openSpace(sp.cwd, sp.usable)}
                    onMouseEnter={() => {
                      onRefreshGitStatus?.(sp.cwd);
                      if (!isActiveSpace && sp.usable[0]) onPrefetch?.(sp.usable[0].path);
                    }}
                    title={`${sp.cwd}${branch ? `\n${branch}` : ""}`}
                    aria-current={isActiveSpace ? "true" : undefined}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: pc }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{projectName(sp.cwd)}</span>
                    {branch && branch !== "main" && branch !== "master" ? (
                      <span className="max-w-[12ch] shrink-0 truncate text-[11px] text-dim">{branch}</span>
                    ) : null}
                    {sp.live > 0 ? <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--ok)]" title={`${sp.live} running`} /> : null}
                    <span className="shrink-0 text-[11px] tabular-nums text-dim">{sp.usable.length}</span>
                  </button>
                  {!isActiveSpace ? (
                    <button
                      type="button"
                      onClick={() => onRemoveSpace(sp.cwd)}
                      title={`Remove ${projectName(sp.cwd)} from Spaces (sessions stay on disk and in Search)`}
                      aria-label={`Remove ${projectName(sp.cwd)} from Spaces`}
                      className="hidden shrink-0 rounded px-1 text-[12px] text-dim hover:text-err group-hover/space:block"
                    >
                      ×
                    </button>
                  ) : null}
                  </div>
                  {isActiveSpace ? (
                    <div className="ml-3 border-l border-line/60 pl-1">
                      {tabs.map((entry) => (
                        <div key={entry.session.path} className="group/tab flex items-center gap-0.5">
                          <div className="min-w-0 flex-1">
                          {renderRow(
                            { session: entry.session, cwd: entry.cwd },
                            pinnedSet.has(entry.session.path) ? "pinned" : "active",
                            true
                          )}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              if (pinnedSet.has(entry.session.path)) onTogglePin(entry.session.path);
                              onCloseTab(entry.cwd, entry.session.path);
                            }}
                            title="Close tab (session stays on disk and in Search)"
                            aria-label={`Close tab ${entry.session.name ?? entry.session.id}`}
                            className="hidden shrink-0 rounded px-1 text-[12px] text-dim hover:text-err group-hover/tab:block"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => (onNewSessionIn ? void onNewSessionIn(sp.cwd) : onNew())}
                        title={`New tab in ${projectName(sp.cwd)}`}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[12px] text-dim hover:text-fg"
                      >
                        <PlusIcon size={13} /> New tab
                      </button>
                      {sp.usable.length > tabs.length ? (
                        <button
                          type="button"
                          onClick={onSearch}
                          title="Older sessions live in Search, resume is rare, browsing is not the job"
                          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[12px] text-dim hover:text-fg"
                        >
                          All {sp.usable.length} in Search ⌘K
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {snoozedList.length > 0 && (
              <>
                <button type="button" onClick={() => setSnoozedExpanded((v) => !v)} aria-expanded={snoozedExpanded} className="sidebar-shelf-toggle">
                  <span className="shelf-label">{snoozedExpanded ? "Snoozed" : `Snoozed (${snoozedList.length})`}</span>
                  <span className="shelf-divider" />
                  <ChevronIcon size={12} className={`shelf-chevron transition-transform ${snoozedExpanded ? "rotate-180" : ""}`} />
                </button>
                {snoozedExpanded && snoozedList.map((entry) => renderRow(entry, "snoozed"))}
              </>
            )}

            {showArchived && archivedList.length > 0 && (
              <>
                <div className="sidebar-section-divider mx-2.5 my-2" />
                <div className="sidebar-section-label px-5 pb-1 pt-3">Archived</div>
                {archivedList.map((entry) => renderRow(entry, "archived"))}
              </>
            )}

          </>
        )}
      </div>

      <div className="shrink-0 overflow-y-auto border-t border-line px-2.5 py-2" style={{ maxHeight: "32%" }}>
        <>
          <div className="sidebar-section-label px-5 pb-1 pt-1">Agents</div>
              {agents && agents.length > 0 ? (
                agents.map((a) => {
                  const dot =
                    a.status === "running" ? "bg-[var(--ok)] animate-pulse" : a.status === "blocked" ? "bg-err" : "bg-warn";
                  return (
                    <div key={`${a.kind}:${a.id}`} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-raised">
                      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} title={a.status} />
                      <button
                        type="button"
                        onClick={() => onOpenAgent?.(a)}
                        title={`${a.label}, ${a.kind} · ${a.status}${a.cwd ? ` · ${a.cwd}` : ""}`}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="block truncate text-[13px]">{a.label}</span>
                        <span className="block truncate text-[11px] text-dim">
                          {a.kind}
                          {a.cwd ? ` · ${projectName(a.cwd)}` : ""}
                        </span>
                      </button>
                      {a.status === "running" ? (
                        <button
                          type="button"
                          onClick={() => onStopAgent?.(a)}
                          title={`Stop ${a.kind}`}
                          className="shrink-0 rounded-md border border-err/30 px-1.5 py-0.5 text-[11px] font-semibold text-err hover:bg-err/10"
                        >
                          Stop
                        </button>
                      ) : (
                        <span className="shrink-0 text-[11px] text-dim">{a.status === "blocked" ? "blocked" : "waiting"}</span>
                      )}
                    </div>
                  );
                })
              ) : (
                <p className="px-3 py-1 text-[12.5px] text-dim">No live agents.</p>
              )}
        </>
      </div>

      <div className="sidebar-footer">
        <button onClick={onOpenFolder} className="sidebar-action">
          <FolderIcon size={16} className="sidebar-action-icon" />
          <span>Open folder…</span>
        </button>
        {archivedList.length > 0 && (
          <button onClick={onToggleShowArchived} className="sidebar-action mt-0.5">
            <ArchiveIcon size={16} className="sidebar-action-icon" />
            <span>{showArchived ? "Hide archived" : `Archived (${archivedList.length})`}</span>
          </button>
        )}
        <button type="button" onClick={onOpenSettings} className="sidebar-action mt-0.5" aria-haspopup="dialog">
          <GearIcon size={16} className="sidebar-action-icon" />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
