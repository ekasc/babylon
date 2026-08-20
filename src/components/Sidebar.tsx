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
  CheckIcon,
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

/* ------------------------------------------------------------------ *
 * Icons (t3code-style glyphs)                                          *
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */
type Section = "pinned" | "active" | "snoozed" | "settled" | "archived";

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
  settled: boolean;
  snoozedUntil: number | undefined;
  unread: boolean;
  archived: boolean;
  onClose(): void;
  onTogglePin(path: string): void;
  onToggleSettle(path: string): void;
  onToggleSnooze(path: string, until?: number): void;
  onToggleUnread(path: string): void;
  onToggleArchive(path: string): void;
  onRename(path: string): void;
  onCopy(kind: "path" | "id" | "branch", session: SessionMeta): void;
  onDelete(path: string, name: string): void;
}) {
  const { session, pinned, settled, snoozedUntil, unread, archived, onClose } = props;
  const isSnoozed = snoozedUntil != null && snoozedUntil > Date.now();
  const [sub, setSub] = useState<"snooze" | "copy" | null>(null);
  const presets = useMemo(() => buildSnoozePresets(Date.now()), []);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="thread-menu fixed z-50"
        style={{ top: Math.min(props.y, window.innerHeight - 360), left: Math.min(props.x, window.innerWidth - 210) }}
      >
        {archived ? (
          <>
            <button className="thread-menu-item" onClick={() => { props.onToggleArchive(session.path); onClose(); }}>Unarchive chat</button>
            <button className="thread-menu-item danger" onClick={() => { props.onDelete(session.path, session.name ?? session.firstUserText ?? session.id); onClose(); }}>Delete chat</button>
          </>
        ) : (
          <>
            <button className="thread-menu-item" onClick={() => { props.onTogglePin(session.path); onClose(); }}>{pinned ? "Unpin chat" : "Pin chat"}</button>
            <button className="thread-menu-item" onClick={() => { props.onToggleSettle(session.path); onClose(); }}>{settled ? "Un-settle chat" : "Settle chat"}</button>
            {isSnoozed ? (
              <button className="thread-menu-item" onClick={() => { props.onToggleSnooze(session.path); onClose(); }}>Wake chat</button>
            ) : (
              <div className="relative" onMouseEnter={() => setSub("snooze")} onMouseLeave={() => setSub(null)}>
                <button className="thread-menu-item" onClick={() => setSub((s) => (s === "snooze" ? null : "snooze"))}>
                  <span>Snooze</span><span className="text-dim">›</span>
                </button>
                {sub === "snooze" && (
                  <div className="thread-menu-sub">
                    {presets.map((p) => (
                      <button key={p.id} className="thread-menu-item" onClick={() => { props.onToggleSnooze(session.path, p.until); onClose(); }}>{p.label}</button>
                    ))}
                    <button className="thread-menu-item" onClick={() => {
                      const v = window.prompt("Snooze until (e.g. 2025-03-10 09:00 or +2h)");
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
            <button className="thread-menu-item" onClick={() => { props.onRename(session.path); onClose(); }}>Rename chat</button>
            <button className="thread-menu-item" onClick={() => { props.onToggleUnread(session.path); onClose(); }}>{unread ? "Mark read" : "Mark unread"}</button>
            <div className="relative" onMouseEnter={() => setSub("copy")} onMouseLeave={() => setSub(null)}>
              <button className="thread-menu-item" onClick={() => setSub((s) => (s === "copy" ? null : "copy"))}>
                <span>Copy</span><span className="text-dim">›</span>
              </button>
              {sub === "copy" && (
                <div className="thread-menu-sub">
                  <button className="thread-menu-item" onClick={() => { props.onCopy("path", session); onClose(); }}>Path</button>
                  <button className="thread-menu-item" onClick={() => { props.onCopy("id", session); onClose(); }}>Chat ID</button>
                  {session.isWorktree && <button className="thread-menu-item" onClick={() => { props.onCopy("branch", session); onClose(); }}>Branch</button>}
                </div>
              )}
            </div>
            <div className="thread-menu-sep" />
            <button className="thread-menu-item" onClick={() => { props.onToggleArchive(session.path); onClose(); }}>Archive chat</button>
            <button className="thread-menu-item danger" onClick={() => { props.onDelete(session.path, session.name ?? session.firstUserText ?? session.id); onClose(); }}>Delete chat</button>
          </>
        )}
      </div>
    </>
  );
}

type ThemePref = "light" | "dark" | "system";
function applyTheme(theme: ThemePref) {
  localStorage.setItem("pideck:theme", theme);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = theme === "dark" || (theme === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
}

function SettingsMenu(props: {
  anchor: { left: number; top: number };
  current: ThemePref;
  onClose(): void;
  onPick(theme: ThemePref): void;
}) {
  const themes: ThemePref[] = ["light", "dark", "system"];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  const left = Math.max(8, Math.min(props.anchor.left, window.innerWidth - 196));
  const bottom = window.innerHeight - props.anchor.top + 8;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={props.onClose} onContextMenu={(e) => { e.preventDefault(); props.onClose(); }} />
      <div className="thread-menu fixed z-50" style={{ left, bottom, minWidth: 180 }}>
        <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-dim">Theme</div>
        {themes.map((t) => (
          <button key={t} className={`thread-menu-item ${props.current === t ? "is-selected" : ""}`} onClick={() => { props.onPick(t); props.onClose(); }}>
            <span className="capitalize">{t}</span>
            {props.current === t && <span className="ml-auto pr-1 text-accent">✓</span>}
          </button>
        ))}
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
  snoozedUntil: number | undefined;
  settled: boolean;
  unread: boolean;
  archived: boolean;
  streaming: boolean;
  agentStatus: "running" | "blocked" | "needs-input" | "done";
  branch?: string;
  gitStatus?: GitStatusResult | null;
  onRefreshGitStatus?: () => void;
  dragIndex: number | null;
  index: number;
  onOpen(path: string | undefined, cwd: string, name?: string): void;
  onPrefetch?(path: string): void;
  onDelete?(path: string, name: string): void;
  onTogglePin(path: string): void;
  onToggleSettle(path: string): void;
  onToggleSnooze(path: string, until?: number): void;
  onToggleUnread(path: string): void;
  onToggleArchive(path: string): void;
  onRename(path: string): void;
  onCopy(kind: "path" | "id" | "branch", session: SessionMeta): void;
  onDragStart?(): void;
  onDragOver?(e: React.DragEvent): void;
  onDrop?(e: React.DragEvent): void;
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
  const { session, cwd, section, active, pinned, snoozedUntil, settled, unread, archived, streaming, dragIndex, index, agentStatus, branch, gitStatus, onRefreshGitStatus } = props;
  const title = session.name ?? session.firstUserText ?? session.id.slice(0, 8);
  const hoverTimer = useRef(0);
  const clickTimer = useRef<number | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const cancelPrefetch = () => { if (hoverTimer.current) { window.clearTimeout(hoverTimer.current); hoverTimer.current = 0; } };
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const isSnoozed = snoozedUntil != null && snoozedUntil > Date.now();
  const timeLabel = isSnoozed && snoozedUntil != null ? snoozeLabel(snoozedUntil, Date.now()) : timeAgo(session.mtime);

  const slim = section === "snoozed" || section === "settled";
  const pc = projectColor(cwd);
  const rowClass =
    `sidebar-session group/session ${active ? "is-active" : ""} ${archived ? "opacity-50" : ""} ${slim ? "is-slim" : ""}` +
    (props.section === "pinned" && dragIndex === index ? " is-dragging" : "");

  const effectiveBranch = gitStatus?.branch ?? branch;
  const gitTip = gitStatus?.isRepo ? gitStatusTooltip(gitStatus) : undefined;
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

  return (
    <div
      className={rowClass}
      style={{ ["--pc" as string]: pc } as React.CSSProperties}
      draggable={props.section === "pinned"}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; props.onDragStart?.(); }}
      onDragOver={(e) => props.onDragOver?.(e)}
      onDrop={(e) => props.onDrop?.(e)}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        draggable={false}
        onClick={(e) => {
          pointer.current = { x: e.clientX, y: e.clientY };
          if (clickTimer.current) {
            window.clearTimeout(clickTimer.current);
            clickTimer.current = null;
            setMenu({ x: pointer.current.x, y: pointer.current.y });
            return;
          }
          clickTimer.current = window.setTimeout(() => {
            clickTimer.current = null;
            props.onOpen(session.path, cwd, title);
          }, 200);
        }}
        onMouseEnter={() => {
          onRefreshGitStatus?.();
          if (!props.onPrefetch || active) return;
          cancelPrefetch();
          hoverTimer.current = window.setTimeout(() => props.onPrefetch?.(session.path), 150);
        }}
        onMouseLeave={() => { cancelPrefetch(); }}
        onFocus={() => { if (props.onPrefetch && !active) props.onPrefetch(session.path); }}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
        title={`${title}\n${session.path}`}
      >
        {slim ? (
          <>
            <span className="shrink-0 text-dim">{isSnoozed ? <ClockIcon size={15} /> : <ChatIcon size={15} />}</span>
            <span className="min-w-0 flex-1 truncate text-dim">{isSnoozed ? timeLabel : title}</span>
            {gitStatus?.isRepo && <GitStatusMeta g={gitStatus} />}
            <span className="sidebar-meta shrink-0 w-12 text-right tabular-nums">{isSnoozed ? "" : timeAgo(session.mtime)}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              {session.isWorktree ? <FlaskIcon size={13} className="shrink-0 text-warn" /> : <FolderIcon size={13} className="shrink-0 text-dim" />}

              <span className="sidebar-project-name sidebar-meta truncate">{projectName(cwd)}</span>
              {active && (
                <span className={`session-status ml-auto ${agentStatus}`}>
                  {agentStatus === "running" && <RunningIcon size={11} />}
                  {agentStatus === "blocked" && <BlockedIcon size={11} />}
                  {agentStatus === "needs-input" && <InputIcon size={11} />}
                  {agentStatus === "done" && <CheckIcon size={11} />}
                  {agentStatus === "needs-input" ? "needs input" : agentStatus}
                </span>
              )}
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              {unread && <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--pc)] align-middle" />}
              {streaming && active && <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400 align-middle" />}
              <span className="truncate text-fg text-[14px] leading-snug">{title}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              {branchNode}
              <span className="sidebar-meta ml-auto shrink-0 tabular-nums">{timeAgo(session.mtime)}</span>
            </span>
          </span>
        )}
      </button>

      {menu &&
        createPortal(
          <ThreadMenu
            x={menu.x}
            y={menu.y}
            session={session}
            pinned={pinned}
            settled={settled}
            snoozedUntil={snoozedUntil}
            unread={unread}
            archived={archived}
            onClose={() => setMenu(null)}
            onTogglePin={props.onTogglePin}
            onToggleSettle={props.onToggleSettle}
            onToggleSnooze={props.onToggleSnooze}
            onToggleUnread={props.onToggleUnread}
            onToggleArchive={props.onToggleArchive}
            onRename={props.onRename}
            onCopy={props.onCopy}
            onDelete={props.onDelete ?? (() => {})}
          />,
          document.body
        )}
    </div>
  );
});

/* ------------------------------------------------------------------ *
 * Sidebar (1:1 with t3code's flat Pinned → Active → Snoozed → Settled) *
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
  onOpen(path: string | undefined, cwd: string, name?: string): void;
  onPrefetch?: (path: string) => void;
  onNew(): void;
  onNewSessionIn?(cwd: string): void;
  onDeleteSession?(path: string, name: string): void;
  onOpenFolder(): void;
  onOpenTree(): void;
  onSearch(): void;
  // t3code-style state (client-persisted)
  pinnedOrder: string[];
  snoozed: Record<string, number>;
  settled: string[];
  archived: string[];
  unread: string[];
  onReorderPinned(order: string[]): void;
  onTogglePin(path: string): void;
  onToggleSnooze(path: string, until?: number): void;
  onToggleSettle(path: string): void;
  onToggleUnread(path: string): void;
  onToggleArchive(path: string): void;
  onRename(path: string): void;
  onCopy(kind: "path" | "id" | "branch", session: SessionMeta): void;
  showArchived: boolean;
  onToggleShowArchived(): void;
  agentState?: "running" | "blocked" | "needs-input" | "done";
  activeBranch?: string;
  gitStatuses?: Record<string, GitStatusResult>;
  onRefreshGitStatus?: (cwd: string) => void;
}

const SETTLED_INITIAL = 10;
const SETTLED_PAGE = 25;

export default function Sidebar(props: Props) {
  const {
    groups, activePath, activeCwd, activeStreaming,
    treeOpen, canOpenTree, minimized, onToggleMinimize,
    onOpen, onPrefetch, onNew, onNewSessionIn, onDeleteSession,
    onOpenFolder, onOpenTree, onSearch,
    pinnedOrder, snoozed, settled, archived, unread,
    onReorderPinned, onTogglePin, onToggleSnooze, onToggleSettle, onToggleUnread, onToggleArchive, onRename, onCopy,
    agentState, activeBranch, gitStatuses, onRefreshGitStatus,
    showArchived, onToggleShowArchived,
  } = props;

  const [snoozedExpanded, setSnoozedExpanded] = useState(true);
  const [settledExpanded, setSettledExpanded] = useState(true);
  const [settledVisible, setSettledVisible] = useState(SETTLED_INITIAL);
  const [projectFilter, setProjectFilter] = useState("all");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

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

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsAnchor, setSettingsAnchor] = useState<{ left: number; top: number } | null>(null);
  const [currentTheme, setCurrentTheme] = useState<ThemePref>(() => {
    const t = localStorage.getItem("pideck:theme");
    return t === "light" || t === "dark" || t === "system" ? t : "dark";
  });

  const pinnedSet = useMemo(() => new Set(pinnedOrder), [pinnedOrder]);
  const settledSet = useMemo(() => new Set(settled), [settled]);
  const archivedSet = useMemo(() => new Set(archived), [archived]);
  const unreadSet = useMemo(() => new Set(unread), [unread]);

  const flat = useMemo(
    () => groups.flatMap((g) => g.sessions.map((s) => ({ session: s, cwd: g.cwd }))),
    [groups]
  );
  const projectCwds = useMemo(() => groups.map((g) => g.cwd), [groups]);

  const now = Date.now();
  const classify = (path: string): Section => {
    if (archivedSet.has(path)) return "archived";
    if (pinnedSet.has(path)) return "pinned";
    const su = snoozed[path];
    if (su != null && su > now) return "snoozed";
    if (settledSet.has(path)) return "settled";
    return "active";
  };

  const visible = useMemo(
    () => flat.filter(({ session }) => projectFilter === "all" || session.cwd === projectFilter),
    [flat, projectFilter]
  );

  const pinnedList = useMemo(() => {
    const pinned = visible.filter(({ session }) => pinnedSet.has(session.path));
    const inOrder = pinnedOrder.filter((p) => pinnedSet.has(p));
    const ordered = inOrder
      .map((p) => pinned.find((x) => x.session.path === p))
      .filter(Boolean) as { session: SessionMeta; cwd: string }[];
    const remainder = pinned
      .filter((x) => !inOrder.includes(x.session.path))
      .sort((a, b) => b.session.mtime - a.session.mtime);
    return [...ordered, ...remainder];
  }, [visible, pinnedOrder, pinnedSet]);

  const activeList = useMemo(
    () => visible.filter(({ session }) => classify(session.path) === "active").sort((a, b) => b.session.mtime - a.session.mtime),
    [visible, pinnedSet, snoozed, settledSet, archivedSet]
  );
  const snoozedList = useMemo(
    () => visible.filter(({ session }) => classify(session.path) === "snoozed").sort((a, b) => (snoozed[a.session.path] ?? 0) - (snoozed[b.session.path] ?? 0)),
    [visible, pinnedSet, snoozed, settledSet, archivedSet]
  );
  const settledList = useMemo(
    () => visible.filter(({ session }) => classify(session.path) === "settled").sort((a, b) => b.session.mtime - a.session.mtime),
    [visible, pinnedSet, snoozed, settledSet, archivedSet]
  );
  const archivedList = useMemo(
    () => visible.filter(({ session }) => archivedSet.has(session.path)).sort((a, b) => b.session.mtime - a.session.mtime),
    [visible, archivedSet]
  );

  const handlePinnedDrop = (to: number) => {
    if (dragIndex == null) return;
    const ids = pinnedList.map((x) => x.session.path);
    const [moved] = ids.splice(dragIndex, 1);
    ids.splice(to, 0, moved);
    onReorderPinned(ids);
    setDragIndex(null);
    setOverIndex(null);
  };

  if (minimized) {
    return (
      <button onClick={onToggleMinimize} title="Show sidebar (⌘B)" aria-label="Show sidebar" className="sidebar-expand fixed left-2 top-10 z-50">
        <ChevronIcon size={16} strokeWidth={2} />
      </button>
    );
  }

  const renderRow = (entry: { session: SessionMeta; cwd: string }, section: Section, index: number) => {
    const active = activePath === entry.session.path;
    return (
    <SessionRow
      key={`${entry.session.path}:${section}`}
      session={entry.session}
      cwd={entry.cwd}
      section={section}
      index={index}
      active={activePath === entry.session.path}
      pinned={section === "pinned"}
      snoozedUntil={snoozed[entry.session.path]}
      settled={settledSet.has(entry.session.path)}
      unread={unreadSet.has(entry.session.path)}
      archived={archivedSet.has(entry.session.path)}
      streaming={activePath === entry.session.path && !!activeStreaming}
      agentStatus={agentState ?? "done"}
      branch={activePath === entry.session.path ? activeBranch : undefined}
      gitStatus={gitStatuses?.[entry.cwd] ?? null}
      onRefreshGitStatus={gitStatuses?.[entry.cwd] ? () => onRefreshGitStatus?.(entry.cwd) : undefined}
      dragIndex={dragIndex}
      onOpen={onOpen}
      onPrefetch={onPrefetch}
      onDelete={onDeleteSession}
      onTogglePin={onTogglePin}
      onToggleSettle={onToggleSettle}
      onToggleSnooze={onToggleSnooze}
      onToggleUnread={onToggleUnread}
      onToggleArchive={onToggleArchive}
      onRename={onRename}
      onCopy={onCopy}
      onDragStart={() => setDragIndex(index)}
      onDragOver={(e) => { e.preventDefault(); setOverIndex(index); }}
      onDrop={(e) => { e.preventDefault(); handlePinnedDrop(index); }}
    />
    );
  }

  const totalThreads =
    pinnedList.length + activeList.length + snoozedList.length + settledList.length + archivedList.length;

  return (
    <aside className="app-sidebar flex shrink-0 flex-col" style={{ width }}>
      <div className="sidebar-resize-handle" onMouseDown={startResize} />
      <div className="titlebar flex h-16 shrink-0 items-center gap-2.5 px-4 pl-[76px]">
        <PiMark size={20} className="shrink-0 text-fg" />
        <span className="text-[16px] font-semibold tracking-[-0.02em]">Babylon</span>
        <button onClick={onToggleMinimize} title="Minimize sidebar (⌘B)" aria-label="Minimize sidebar" className="sidebar-toggle ml-auto">
          <ChevronIcon size={14} className="rotate-180" />
        </button>
      </div>

      <nav aria-label="Workspace" className="px-2.5">
        <button onClick={onNew} className="sidebar-action">
          <PlusIcon size={16} className="sidebar-action-icon" />
          <span>New session</span>
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

      {projectCwds.length > 1 && (
        <div className="px-2.5 pb-2 pt-2">
          <ProjectFilter
            projects={projectCwds.map((c) => ({ cwd: c, name: projectName(c) }))}
            value={projectFilter}
            onChange={setProjectFilter}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {totalThreads === 0 ? (
          <p className="px-3 py-3 text-[14px] leading-6 text-dim">
            {projectFilter !== "all" ? "No chats in this project." : "Open a folder to start your first session."}
          </p>
        ) : (
          <>
            {pinnedList.map((entry, i) => renderRow(entry, "pinned", i))}
            {pinnedList.length > 0 && <div className="sidebar-section-divider mx-2.5 my-2" />}

            {activeList.map((entry, i) => renderRow(entry, "active", i))}

            {snoozedList.length > 0 && (
              <>
                <button type="button" onClick={() => setSnoozedExpanded((v) => !v)} aria-expanded={snoozedExpanded} className="sidebar-shelf-toggle">
                  <span className="shelf-label">{snoozedExpanded ? "Snoozed" : `Snoozed (${snoozedList.length})`}</span>
                  <span className="shelf-divider" />
                  <ChevronIcon size={12} className={`shelf-chevron transition-transform ${snoozedExpanded ? "rotate-180" : ""}`} />
                </button>
                {snoozedExpanded && snoozedList.map((entry, i) => renderRow(entry, "snoozed", i))}
              </>
            )}

            {settledList.length > 0 && (
              <>
                <button type="button" onClick={() => setSettledExpanded((v) => !v)} aria-expanded={settledExpanded} className="sidebar-shelf-toggle">
                  <span className="shelf-label">{settledExpanded ? "Settled" : `Settled (${settledList.length})`}</span>
                  <span className="shelf-divider" />
                  <ChevronIcon size={12} className={`shelf-chevron transition-transform ${settledExpanded ? "rotate-180" : ""}`} />
                </button>
                {settledExpanded &&
                  settledList.slice(0, settledVisible).map((entry, i) => renderRow(entry, "settled", i))}
                {settledExpanded && settledVisible < settledList.length && (
                  <button type="button" onClick={() => setSettledVisible((n) => n + SETTLED_PAGE)} className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-dim hover:bg-[var(--pressed)] hover:text-fg">
                    <PlusIcon size={14} /> Show {Math.min(SETTLED_PAGE, settledList.length - settledVisible)} more
                  </button>
                )}
              </>
            )}

            {showArchived && archivedList.length > 0 && (
              <>
                <div className="sidebar-section-divider mx-2.5 my-2" />
                <div className="sidebar-section-label px-5 pb-1 pt-3">Archived</div>
                {archivedList.map((entry, i) => renderRow(entry, "archived", i))}
              </>
            )}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <button onClick={onOpenFolder} className="sidebar-action">
          <FolderIcon size={14} className="sidebar-action-icon" />
          <span>Open folder…</span>
        </button>
        {archivedList.length > 0 && (
          <button onClick={onToggleShowArchived} className="sidebar-action mt-0.5">
            <ArchiveIcon size={14} className="sidebar-action-icon" />
            <span>{showArchived ? "Hide archived" : `Archived (${archivedList.length})`}</span>
          </button>
        )}
        <button type="button" onClick={(e) => { setSettingsAnchor(e.currentTarget.getBoundingClientRect()); setSettingsOpen((v) => !v); }} className="sidebar-action mt-0.5" aria-haspopup="menu" aria-expanded={settingsOpen}>
          <GearIcon size={14} className="sidebar-action-icon" />
          <span>Settings</span>
        </button>
        {settingsOpen && settingsAnchor &&
          createPortal(
            <SettingsMenu anchor={settingsAnchor} current={currentTheme} onClose={() => setSettingsOpen(false)} onPick={(t) => { applyTheme(t); setCurrentTheme(t); }} />,
            document.body
          )}
      </div>
    </aside>
  );
}
