import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { clampHard, clampWithRubberband } from "../lib/gesture-math";
import type { GitStatusResult, ProjectGroup, SessionMeta } from "../bridge";
import {
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
	PlusIcon,
	RunningIcon,
	SearchIcon,
} from "./icons";
import ProjectFilter from "./ProjectFilter";
import { ProjectIcon } from "./ProjectIcon";
import { AgentsSection, type AgentRow } from "./AgentsSection";
import {
	compareSettled,
	formatRunDuration,
	isLiveExecution,
	canSettle,
	deriveSpaceAttention,
	statusDotKind,
	type ExecutionState,
	type SessionRuntimeState,
} from "../sessionRuntime";
import { projectColor } from "../lib/colors";
import { promptText } from "../lib/prompts";

/* ------------------------------------------------------------------ *
 * Icons (t3code-style glyphs)                                          *
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */
type Section = "pinned" | "active" | "snoozed" | "archived" | "settled";

/** Isolated ticking duration: only this span rerenders each second, never the row. */
function WorkingTimer({ startedAt }: { startedAt: number }) {
	const [, tick] = useState(0);
	useEffect(() => {
		const id = window.setInterval(() => tick((t) => t + 1), 1000);
		return () => window.clearInterval(id);
	}, []);
	return (
		<span className="tabular-nums">
			{formatRunDuration(Date.now() - startedAt)}
		</span>
	);
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
	return new Date(ms).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
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
		{
			id: "tomorrow",
			label: "Tomorrow",
			until: atTime(addDays(new Date(now), 1), 9),
		},
		{
			id: "week",
			label: "Next week",
			until: atTime(nextWeekday(new Date(now), 1), 9),
		},
		{
			id: "month",
			label: "Next month",
			until: atTime(addDays(new Date(now), 30), 9),
		},
	];
}
function snoozeLabel(until: number, now: number): string {
	const d = new Date(until);
	const today = new Date(now);
	const tomorrow = new Date(now + 86400_000);
	if (d.toDateString() === today.toDateString())
		return `Snoozed until ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
	if (d.toDateString() === tomorrow.toDateString())
		return "Snoozed until tomorrow";
	return `Snoozed until ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/* ------------------------------------------------------------------ *
 * Context menu (1:1 with t3code's thread action menu)                  *
 * ------------------------------------------------------------------ */
export function ThreadMenu(props: {
	x: number;
	y: number;
	session: SessionMeta;
	pinned: boolean;
	snoozedUntil: number | undefined;
	unread: boolean;
	archived: boolean;
	settled?: boolean;
	isActive?: boolean;
	canSettle?: boolean;
	onClose(): void;
	onTogglePin(path: string): void;
	onToggleSnooze(path: string, until?: number): void;
	onToggleUnread(path: string): void;
	onToggleArchive(path: string): void;
	onSettle(path: string): void;
	onUnsettle(path: string): void;
	onRename(path: string, currentName?: string): void;
	onCopy(kind: "path" | "id" | "branch", session: SessionMeta): void;
	onDelete(path: string, name: string): void;
	onCreateHandoff?(path: string): void;
	onConsumeHandoff?(path: string): void;
}) {
	const {
		session,
		pinned,
		snoozedUntil,
		unread,
		archived,
		settled,
		isActive,
		canSettle,
		onClose,
	} = props;
	const isSnoozed = snoozedUntil != null && snoozedUntil > Date.now();
	const presets = useMemo(() => buildSnoozePresets(Date.now()), []);
	// Coordinate-anchored floating menu: the right-click point acts as a
	// zero-size virtual anchor (the existing clamp math already keeps it
	// on-screen). Base UI owns the floating placement from there.
	const anchor = useMemo(
		() => ({
			getBoundingClientRect: () => ({
				x: props.x,
				y: props.y,
				top: props.y,
				left: props.x,
				right: props.x,
				bottom: props.y,
				width: 0,
				height: 0,
			}),
		}),
		[props.x, props.y],
	);

	// Base UI Menu owns open state for the hover submenus, ArrowUp/Down
	// navigation, Enter/Space activation, Escape dismissal, disabled-item
	// skipping, focus return, and menu roles. `closeOnClick={false}` keeps
	// Babylon's explicit action-then-close flow (including the async
	// "Pick a time…" prompt) unchanged. All visual classes are unchanged;
	// the submenu popup keeps `.thread-menu-sub` visuals with its CSS
	// absolute positioning neutralized (floating placement comes from the
	// submenu Positioner instead).
	return (
		<Menu.Root
			open
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<Menu.Portal>
				<Menu.Positioner
					anchor={anchor}
					side="bottom"
					align="start"
					className="z-50"
				>
					<Menu.Popup
						aria-label={`Chat actions for ${session.name ?? session.id}`}
						className="fixed thread-menu"
					>
						{archived ? (
							<>
								<Menu.Item
									closeOnClick={false}
									className="thread-menu-item"
									onClick={() => {
										props.onToggleArchive(session.path);
										onClose();
									}}
								>
									Unarchive chat
								</Menu.Item>
								<Menu.Item
									closeOnClick={false}
									className="thread-menu-item danger"
									onClick={() => {
										props.onDelete(
											session.path,
											session.name ??
												session.firstUserText ??
												session.id,
										);
										onClose();
									}}
								>
									Delete chat
								</Menu.Item>
							</>
						) : settled ? (
							<>
								<Menu.Item
									closeOnClick={false}
									className="thread-menu-item"
									onClick={() => {
										props.onUnsettle(session.path);
										onClose();
									}}
								>
									Un-settle chat
								</Menu.Item>
								<div className="thread-menu-sep" />
								<Menu.Item
									closeOnClick={false}
									className="thread-menu-item"
									onClick={() => {
										props.onToggleArchive(session.path);
										onClose();
									}}
								>
									Archive chat
								</Menu.Item>
								<Menu.Item
									closeOnClick={false}
									className="thread-menu-item danger"
									onClick={() => {
										props.onDelete(
											session.path,
											session.name ??
												session.firstUserText ??
												session.id,
										);
										onClose();
									}}
								>
									Delete chat
								</Menu.Item>
							</>
						) : (
							<>
								<Menu.Item
									closeOnClick={false}
									className="thread-menu-item"
									onClick={() => {
										props.onTogglePin(session.path);
										onClose();
									}}
								>
									{pinned ? "Unpin chat" : "Pin chat"}
								</Menu.Item>
								{isSnoozed ? (
									<Menu.Item
										closeOnClick={false}
										className="thread-menu-item"
										onClick={() => {
											props.onToggleSnooze(session.path);
											onClose();
										}}
									>
										Wake chat
									</Menu.Item>
								) : (
									<div className="relative">
										<Menu.SubmenuRoot>
											<Menu.SubmenuTrigger className="thread-menu-item">
												<span>Snooze</span>
												<span className="text-dim">
													›
												</span>
											</Menu.SubmenuTrigger>
											<Menu.Positioner
												side="right"
												align="start"
												sideOffset={2}
												alignOffset={-4}
											>
												<Menu.Popup
													aria-label="Snooze presets"
													className="thread-menu-sub"
													style={{
														position: "static",
													}}
												>
													{presets.map((p) => (
														<Menu.Item
															key={p.id}
															closeOnClick={false}
															className="thread-menu-item"
															onClick={() => {
																props.onToggleSnooze(
																	session.path,
																	p.until,
																);
																onClose();
															}}
														>
															{p.label}
														</Menu.Item>
													))}
													<Menu.Item
														closeOnClick={false}
														className="thread-menu-item"
														onClick={async () => {
															const v =
																await promptText(
																	{
																		title: "Snooze until",
																		message:
																			"e.g. 2025-03-10 09:00 or +2h",
																		placeholder:
																			"2025-03-10 09:00",
																	},
																);
															if (!v)
																return onClose();
															let until =
																Number.NaN;
															if (
																v.startsWith(
																	"+",
																)
															)
																until =
																	Date.now() +
																	parseFloat(
																		v.slice(
																			1,
																		),
																	) *
																		(v.includes(
																			"h",
																		)
																			? 3600_000
																			: v.includes(
																						"d",
																				  )
																				? 86400_000
																				: 60_000);
															else
																until =
																	Date.parse(
																		v,
																	);
															if (
																Number.isNaN(
																	until,
																)
															)
																return onClose();
															props.onToggleSnooze(
																session.path,
																until,
															);
															onClose();
														}}
													>
														Pick a time…
													</Menu.Item>
												</Menu.Popup>
											</Menu.Positioner>
										</Menu.SubmenuRoot>
									</div>
								)}
								<div className="thread-menu-sep" />
								<Menu.Item
									closeOnClick={false}
									className="thread-menu-item"
									onClick={() => {
										props.onRename(session.path, session.name ?? session.firstUserText ?? undefined);
										onClose();
									}}
								>
									Rename chat
								</Menu.Item>
								<Menu.Item
									closeOnClick={false}
									className="thread-menu-item"
									onClick={() => {
										props.onToggleUnread(session.path);
										onClose();
									}}
								>
									{unread ? "Mark read" : "Mark unread"}
								</Menu.Item>
								<Menu.Item
									closeOnClick={false}
									className="thread-menu-item"
									onClick={() => {
										props.onCopy(
											"path",
											session,
										);
										onClose();
									}}
								>
									<span>Copy path</span>
									<kbd className="ml-auto text-[12px] text-dim">⌘⇧C</kbd>
								</Menu.Item>
								<div className="relative">
									<Menu.SubmenuRoot>
										<Menu.SubmenuTrigger className="thread-menu-item">
											<span>Copy</span>
											<span className="text-dim">›</span>
										</Menu.SubmenuTrigger>
										<Menu.Positioner
											side="right"
											align="start"
											sideOffset={2}
											alignOffset={-4}
										>
											<Menu.Popup
												aria-label="Copy options"
												className="thread-menu-sub"
												style={{ position: "static" }}
											>
												<Menu.Item
													closeOnClick={false}
													className="thread-menu-item"
													onClick={() => {
														props.onCopy(
															"id",
															session,
														);
														onClose();
													}}
												>
													Chat ID
												</Menu.Item>
												{session.isWorktree && (
													<Menu.Item
														closeOnClick={false}
														className="thread-menu-item"
														onClick={() => {
															props.onCopy(
																"branch",
																session,
															);
															onClose();
														}}
													>
														Branch
													</Menu.Item>
												)}
											</Menu.Popup>
										</Menu.Positioner>
									</Menu.SubmenuRoot>
								</div>
								{props.onCreateHandoff ||
								props.onConsumeHandoff ? (
									<div className="thread-menu-sep" />
								) : null}
								{props.onCreateHandoff ? (
									<Menu.Item
										closeOnClick={false}
										className="thread-menu-item"
										onClick={() => {
											props.onCreateHandoff?.(
												session.path,
											);
											onClose();
										}}
									>
										Create handoff…
									</Menu.Item>
								) : null}
								{props.onConsumeHandoff ? (
									<Menu.Item
										closeOnClick={false}
										className="thread-menu-item"
										onClick={() => {
											props.onConsumeHandoff?.(
												session.path,
											);
											onClose();
										}}
									>
										Consume latest handoff
									</Menu.Item>
								) : null}
								<div className="thread-menu-sep" />
								<Menu.Item
									closeOnClick={false}
									className="thread-menu-item"
									disabled={!canSettle}
									title={
										!canSettle
											? "Still working — settle after this run finishes"
											: isActive
												? "Settle this chat and move to another tab"
												: "Move to Settled; restorable with Un-settle"
									}
									onClick={() => {
										props.onSettle(session.path);
										onClose();
									}}
								>
									Settle chat
								</Menu.Item>
								<Menu.Item
									closeOnClick={false}
									className="thread-menu-item"
									onClick={() => {
										props.onToggleArchive(session.path);
										onClose();
									}}
								>
									Archive chat
								</Menu.Item>
								<Menu.Item
									closeOnClick={false}
									className="thread-menu-item danger"
									onClick={() => {
										props.onDelete(
											session.path,
											session.name ??
												session.firstUserText ??
												session.id,
										);
										onClose();
									}}
								>
									Delete chat
								</Menu.Item>
							</>
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
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
	settled: boolean;
	/** Canonical execution for this row; tabs dot and badges all read this. */
	execution: ExecutionState;
	startedAt?: number | null;
	branch?: string;
	gitStatus?: GitStatusResult | null;
	onRefreshGitStatus?: (cwd: string) => void;
	onOpen(path: string | undefined, cwd: string, name?: string): void;
	onPrefetch?(path: string): void;
	onDelete?(path: string, name: string): void;
	onTogglePin(path: string): void;
	onToggleSnooze(path: string, until?: number): void;
	onToggleUnread(path: string): void;
	onToggleArchive(path: string): void;
	onSettle(path: string): void;
	onUnsettle(path: string): void;
	onRename(path: string, currentName?: string): void;
	onCopy(kind: "path" | "id" | "branch", session: SessionMeta): void;
	onCreateHandoff?(path: string): void;
	onConsumeHandoff?(path: string): void;
}

/** Live agent for the Agents dock: jump to it or stop it. Default Pi runs are
 *  kind "session" (opened, never stopped from the dock: abort is
 *  active-session scoped); threads/subagents/workflows can also be stopped. */
// Git status meta: only commit divergence (ahead / behind), each colored by meaning.
function GitStatusMeta({ g }: { g: GitStatusResult }) {
	return (
		<>
			{g.ahead > 0 && (
				<span className="flex gap-0.5 items-center tabular-nums git-ahead shrink-0">
					<ArrowUpIcon size={11} />
					{g.ahead}
				</span>
			)}
			{g.behind > 0 && (
				<span className="flex gap-0.5 items-center tabular-nums git-behind shrink-0">
					<ArrowDownIcon size={11} />
					{g.behind}
				</span>
			)}
			{g.isWorktree && (
				<span className="flex gap-0.5 items-center git-worktree shrink-0">
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
		for (const f of g.dirty.slice(0, 50))
			lines.push(`  ${f.status} ${f.path}`);
		if (g.dirty.length > 50)
			lines.push(`  …and ${g.dirty.length - 50} more`);
	} else {
		lines.push("Working tree clean");
	}
	if (g.ahead || g.behind)
		lines.push(`Ahead ${g.ahead} / Behind ${g.behind}`);
	return lines.join("\n");
}

const SessionRow = memo(function SessionRow(props: RowProps) {
	const {
		session,
		cwd,
		section,
		active,
		pinned,
		snoozedUntil,
		unread,
		archived,
		settled,
		execution,
		startedAt,
		branch,
		gitStatus,
		onRefreshGitStatus,
	} = props;
	const title =
		session.name ?? session.firstUserText ?? session.id.slice(0, 8);
	const hoverTimer = useRef(0);
	const cancelPrefetch = () => {
		if (hoverTimer.current) {
			window.clearTimeout(hoverTimer.current);
			hoverTimer.current = 0;
		}
	};
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const isSnoozed = snoozedUntil != null && snoozedUntil > Date.now();
	const timeLabel =
		isSnoozed && snoozedUntil != null
			? snoozeLabel(snoozedUntil, Date.now())
			: timeAgo(session.mtime);

	const slim = section === "snoozed";
	const pc = projectColor(cwd);
	const rowClass = `sidebar-session group/session ${active ? "is-active" : ""} ${archived ? "opacity-50" : ""} ${slim ? "is-slim" : ""}`;

	const effectiveBranch = gitStatus?.branch ?? branch;
	const gitTip = gitStatus?.isRepo ? gitStatusTooltip(gitStatus) : undefined;
	// Single status badge shared by both layouts; absent when idle so quiet
	// rows stay quiet and live rows stand out. One label only: approval beats
	// working beats failed beats waiting (canonical priority).
	const statusBadge =
		execution !== "idle" ? (
			<span
				className={`session-status ml-auto ${execution === "working" ? "running" : execution === "failed" ? "failed" : execution === "approval" ? "approval" : "needs-input"}`}
			>
				{execution === "working" && <RunningIcon size={11} />}
				{execution === "failed" && <BlockedIcon size={11} />}
				{(execution === "waiting" || execution === "approval") && (
					<InputIcon size={11} />
				)}
				{execution === "working" ? (
					<span className="inline-flex gap-1 items-center">
						Working
						{startedAt != null ? (
							<WorkingTimer startedAt={startedAt} />
						) : null}
					</span>
				) : execution === "approval" ? (
					"approval"
				) : execution === "failed" ? (
					"failed"
				) : (
					"needs input"
				)}
			</span>
		) : null;
	// Branch/metadata line carries signal only: a non-default branch, a
	// worktree, or ahead/behind/dirty state. Default-branch rows keep a spacer
	// so every non-slim row stays the same height (no reflow as git loads).
	const defaultBranch =
		effectiveBranch === "main" ||
		effectiveBranch === "master" ||
		!effectiveBranch;
	const branchSignal = gitStatus?.isRepo
		? !defaultBranch ||
			gitStatus.isWorktree ||
			gitStatus.ahead > 0 ||
			gitStatus.behind > 0 ||
			gitStatus.dirty.length > 0
		: !defaultBranch;
	const branchNode = (
		<span
			className="flex gap-1.5 items-center min-w-0 sidebar-branch sidebar-meta"
			title={gitTip}
		>
			{branchSignal ? (
				gitStatus?.isRepo ? (
					<>
						<BranchIcon
							size={12}
							className="shrink-0 text-[var(--git)]"
						/>
						{effectiveBranch && (
							<span className="min-w-0 truncate">
								{effectiveBranch}
							</span>
						)}
						<GitStatusMeta g={gitStatus} />
					</>
				) : (
					<>
						<BranchIcon
							size={12}
							className="shrink-0 text-[var(--git)]"
						/>
						<span className="min-w-0 truncate">
							{effectiveBranch}
						</span>
					</>
				)
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
	// Base UI Menu.Portal renders into document.body, so no manual portal
	// is needed here.
	const menuPortal = menu && (
		<ThreadMenu
			x={menu.x}
			y={menu.y}
			session={session}
			pinned={pinned}
			snoozedUntil={snoozedUntil}
			unread={unread}
			archived={archived}
			settled={settled}
			isActive={active}
			canSettle={canSettle(execution)}
			onClose={() => setMenu(null)}
			onTogglePin={props.onTogglePin}
			onToggleSnooze={props.onToggleSnooze}
			onToggleUnread={props.onToggleUnread}
			onToggleArchive={props.onToggleArchive}
			onSettle={props.onSettle}
			onUnsettle={props.onUnsettle}
			onRename={props.onRename}
			onCopy={props.onCopy}
			onCreateHandoff={props.onCreateHandoff}
			onConsumeHandoff={props.onConsumeHandoff}
			onDelete={props.onDelete ?? (() => {})}
		/>
	);
	const content = slim ? (
		<>
			<span className="shrink-0 text-dim">
				{isSnoozed ? <ClockIcon size={15} /> : <ChatIcon size={15} />}
			</span>
			{(() => {
				const dot = statusDotKind(execution, unread);
				if (!dot) return null;
				const cls =
					dot === "approval"
						? "animate-pulse bg-warn"
						: dot === "failed"
							? "bg-err"
							: dot === "unread"
								? "bg-[var(--pc)]"
								: "animate-pulse bg-[var(--ok)]";
				return (
					<span
						className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full align-middle ${cls}`}
					/>
				);
			})()}
			<span className="flex-1 min-w-0 truncate text-dim">
				{isSnoozed ? timeLabel : title}
			</span>
			{gitStatus?.isRepo && <GitStatusMeta g={gitStatus} />}
			<span className="w-12 tabular-nums text-right sidebar-meta shrink-0">
				{isSnoozed ? "" : timeAgo(session.mtime)}
			</span>
		</>
	) : props.hideProject ? (
		<span className="flex-1 min-w-0">
			<span className="flex gap-1.5 items-center min-w-0">
				{unread && execution !== "approval" && (
					<span className="inline-block w-1.5 h-1.5 align-middle rounded-full shrink-0 bg-[var(--pc)]" />
				)}
				{isLiveExecution(execution) && (
					<span className="inline-block w-1.5 h-1.5 align-middle rounded-full animate-pulse shrink-0 bg-[var(--ok)]" />
				)}
				<span className="leading-snug truncate text-[13px]">
					{title}
				</span>
				{execution !== "idle" ? (
					<span
						className={`session-status ml-auto shrink-0 ${execution === "working" ? "running" : execution === "failed" ? "failed" : execution === "approval" ? "approval" : "needs-input"}`}
					>
						{execution === "working" ? (
							<span className="inline-flex gap-1 items-center">
								Working
								{startedAt != null ? (
									<>
										&nbsp;
										<WorkingTimer startedAt={startedAt} />
									</>
								) : null}
							</span>
						) : execution === "approval" ? (
							"approval"
						) : execution === "failed" ? (
							"failed"
						) : (
							"needs input"
						)}
					</span>
				) : (
					<span className="ml-auto tabular-nums sidebar-meta shrink-0">
						{timeAgo(session.mtime)}
					</span>
				)}
			</span>
		</span>
	) : (
		<span className="flex-1 min-w-0">
			<span className="flex gap-1.5 items-center min-w-0">
				{session.isWorktree ? (
					<FlaskIcon size={13} className="shrink-0 text-warn" />
				) : (
					<FolderIcon size={13} className="shrink-0 text-dim" />
				)}

				<span className="sidebar-project-name sidebar-meta truncate">
					{projectName(cwd)}
				</span>
				{statusBadge}
			</span>
			<span className="flex gap-1.5 items-center min-w-0">
				{unread && execution !== "approval" && (
					<span className="inline-block w-1.5 h-1.5 align-middle rounded-full shrink-0 bg-[var(--pc)]" />
				)}
				{execution === "working" && (
					<span className="inline-block w-1.5 h-1.5 align-middle rounded-full animate-pulse shrink-0 bg-[var(--ok)]" />
				)}
				<span className="leading-snug truncate text-fg text-[14px]">
					{title}
				</span>
			</span>
			<span className="flex gap-1.5 items-center min-w-0">
				{branchNode}
				<span className="ml-auto tabular-nums sidebar-meta shrink-0">
					{timeAgo(session.mtime)}
				</span>
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
				onRefreshGitStatus?.(cwd);
				if (!props.onPrefetch || active) return;
				cancelPrefetch();
				hoverTimer.current = window.setTimeout(
					() => props.onPrefetch?.(session.path),
					150,
				);
			}}
			onMouseLeave={() => {
				cancelPrefetch();
			}}
			onFocus={() => {
				if (props.onPrefetch && !active) props.onPrefetch(session.path);
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				setMenu({ x: e.clientX, y: e.clientY });
			}}
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
		<div className={rowClass} style={rowStyle}>
			{button}
			{canSettle(execution) && !settled ? (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						props.onSettle(session.path);
					}}
					title="Settle chat"
					aria-label={`Settle ${title}`}
					className="grid shrink-0 place-items-center rounded-md p-1.5 text-dim opacity-0 transition-opacity hover:bg-inset hover:text-fg focus-visible:opacity-100 group-hover/session:opacity-100"
				>
					<CheckIcon size={13} />
				</button>
			) : null}
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
	onSelectSpace(cwd: string): void;
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
	onRename(path: string, currentName?: string): void;
	onCopy(kind: "path" | "id" | "branch", session: SessionMeta): void;
	onCreateHandoff?(path: string): void;
	onConsumeHandoff?(path: string): void;
	showArchived: boolean;
	onToggleShowArchived(): void;
	/** Canonical runtime per session path (lifecycle × execution × attention).
	 *  The only liveness source rows, Space dots, and the dock read. */
	runtime?: Record<string, SessionRuntimeState>;
	/** Explicit settlement (path -> settled timestamp). */
	settled: Record<string, number>;
	onSettle(path: string): void;
	onUnsettle(path: string): void;
	/** Live session agents (derived in App): executing, waiting, needing
	 *  input, or failed-but-unsettled. Clicking activates the session. */
	liveAgents: AgentRow[];
	allSpaceCwds: string[];
	onOpenLiveAgent(row: AgentRow): void;
	/** User-curated space folders. The session index is never auto-imported. */
	spaceCwds: string[];
	onAddSpace(): void;
	onRemoveSpace(cwd: string): void;
	activeBranch?: string;
	gitStatuses?: Record<string, GitStatusResult>;
	onRefreshGitStatus?: (cwd: string) => void;
}

export default memo(function Sidebar(props: Props) {
	const {
		groups,
		activePath,
		activeCwd,
		treeOpen,
		canOpenTree,
		minimized,
		onToggleMinimize,
		onOpenSettings,
		onOpen,
		onPrefetch,
		onNew,
		onSelectSpace,
		onDeleteSession,
		onOpenFolder,
		onOpenTree,
		onSearch,
		projectFilter,
		onProjectFilterChange,
		pinnedOrder,
		snoozed,
		archived,
		unread,
		onTogglePin,
		onToggleSnooze,
		onToggleUnread,
		onToggleArchive,
		onRename,
		onCopy,
		onCreateHandoff,
		onConsumeHandoff,
		runtime,
		settled,
		onSettle,
		onUnsettle,
		liveAgents,
		allSpaceCwds,
		onOpenLiveAgent,
		spaceCwds,
		onAddSpace,
		onRemoveSpace,
		activeBranch,
		gitStatuses,
		onRefreshGitStatus,
		showArchived,
		onToggleShowArchived,
	} = props;

	const [snoozedExpanded, setSnoozedExpanded] = useState(true);
	const [settledExpanded, setSettledExpanded] = useState(false);
	const [settledShowAll, setSettledShowAll] = useState(false);
	const SETTLED_LIMIT = 5;

	const [width, setWidth] = useState(() => {
		const w = Number(localStorage.getItem("babylon:sidebar-width"));
		return w >= 220 && w <= 560 ? w : 256;
	});
	const widthRef = useRef(width);
	widthRef.current = width;
	const startResize = (e: React.PointerEvent) => {
		// Pointer Events (not mouse-only) + capture so tracking continues
		// past the handle bounds on mouse, touch, and pen alike.
		if (e.button !== 0) return;
		e.preventDefault();
		const handle = e.currentTarget;
		handle.setPointerCapture?.(e.pointerId);
		const pointerId = e.pointerId;
		const startX = e.clientX;
		const startW = widthRef.current;
		document.body.classList.add("sidebar-resizing");
		const finish = (persist: boolean) => {
			document.body.classList.remove("sidebar-resizing");
			if (persist) {
				// Snap back to the hard bound after rubber-band overshoot.
				setWidth((w) => {
					const clamped = clampHard(w, 220, 560);
					localStorage.setItem("babylon:sidebar-width", String(clamped));
					return clamped;
				});
			}
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onEnd);
			window.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("blur", onBlur);
		};
		const onMove = (ev: PointerEvent) => {
			if (ev.pointerId !== pointerId) return;
			// 1:1 tracking inside the bounds, progressive resistance past
			// them — a hard stop reads as frozen, resistance as responsive.
			setWidth(clampWithRubberband(startW + (ev.clientX - startX), 220, 560, startW));
		};
		const onEnd = (ev: PointerEvent) => {
			if (ev.pointerId === pointerId) finish(true);
		};
		// Interrupted gestures (touch cancel, window blur) must never leave
		// the resizing class or listeners behind.
		const onCancel = (ev: PointerEvent) => {
			if (ev.pointerId === pointerId) finish(false);
		};
		const onBlur = () => finish(false);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onEnd);
		window.addEventListener("pointercancel", onCancel);
		window.addEventListener("blur", onBlur);
	};

	const pinnedSet = useMemo(() => new Set(pinnedOrder), [pinnedOrder]);
	const archivedSet = useMemo(() => new Set(archived), [archived]);
	const unreadSet = useMemo(() => new Set(unread), [unread]);

	const flat = useMemo(
		() =>
			groups.flatMap((g) =>
				g.sessions.map((s) => ({ session: s, cwd: g.cwd })),
			),
		[groups],
	);
	// Snooze expirations are time-based: without a tick, an expiry while the
	// app sits idle never re-renders and the session sticks in its shelf.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(t);
	}, []);
	const isSettledPath = (path: string) => settled[path] != null;
	const snoozedList = useMemo(
		() =>
			flat
				.filter(({ session }) => {
					// Shelf precedence (archived > settled > pinned > snoozed),
					// inlined on reactive values so the memo tracks
					// settled/expiry instead of a function identity.
					if (archivedSet.has(session.path)) return false;
					if (settled[session.path] != null) return false;
					if (pinnedSet.has(session.path)) return false;
					const su = snoozed[session.path];
					return su != null && su > now;
				})
				.sort(
					(a, b) =>
						(snoozed[a.session.path] ?? 0) -
						(snoozed[b.session.path] ?? 0),
				),
		[flat, pinnedSet, snoozed, archivedSet, settled, now],
	);
	const archivedList = useMemo(
		() =>
			flat
				.filter(({ session }) => archivedSet.has(session.path))
				.sort((a, b) => b.session.mtime - a.session.mtime),
		[flat, archivedSet],
	);
	// Settled shelf: finished work, newest-settled first on the authoritative
	// settled timestamp (never mtime, so age and ordering cannot disagree).
	const settledList = useMemo(
		() =>
			flat
				.filter(
					({ session }) =>
						settled[session.path] != null &&
						!archivedSet.has(session.path),
				)
				.map((e) => ({ ...e, settledAt: settled[e.session.path] ?? 0 }))
				.sort((a, b) =>
					compareSettled(
						{ path: a.session.path, at: a.settledAt },
						{ path: b.session.path, at: b.settledAt },
					),
				),
		[flat, settled, archivedSet],
	);
	// Spaces (herdr): user-curated only, never auto-imported from the session
	// index. The active project always shows (transiently) so you see where
	// you are; everything else appears only after you add it. Counts exclude
	// archived, snoozed, and settled sessions; resume lives in Search.
	const spaces = useMemo(() => {
		const cwds = [...spaceCwds];
		if (activeCwd && !cwds.includes(activeCwd)) cwds.unshift(activeCwd);
		const byCwd = new Map(groups.map((g) => [g.cwd, g.sessions]));
		const rows = cwds.map((cwd) => {
			const sessions = [...(byCwd.get(cwd) ?? [])].sort(
				(a, b) => b.mtime - a.mtime,
			);
			const usable = sessions.filter((s) => {
				if (archivedSet.has(s.path)) return false;
				if (settled[s.path] != null) return false;
				const su = snoozed[s.path];
				return !(su != null && su > now);
			});
			const live = usable.filter((s) =>
				isLiveExecution(runtime?.[s.path]?.execution ?? "idle"),
			).length;
			// Project attention is the highest-priority child attention — derived,
			// never set independently.
			const attention = deriveSpaceAttention(
				usable.map((s) => runtime?.[s.path]?.attention ?? "none"),
			);
			return {
				cwd,
				usable,
				live,
				attention,
				latest: usable[0]?.mtime ?? 0,
			};
		});
		return rows.sort((a, b) => {
			if (a.cwd === activeCwd) return -1;
			if (b.cwd === activeCwd) return 1;
			return b.latest - a.latest;
		});
	}, [groups, archivedSet, snoozed, settled, runtime, activeCwd, spaceCwds, now]);
	// Space selection is owned by App (global tabs + active project context).
	// Spaces carry no nested sessions: navigation lives in the tab strip.
	const openSpace = (cwd: string) => {
		onSelectSpace(cwd);
	};

	if (minimized) {
		// The expand control lives in the thread header (App.tsx) so it never
		// collides with the macOS traffic lights' click region.
		return null;
	}

	const renderRow = (
		entry: { session: SessionMeta; cwd: string },
		section: Section,
		hideProject = false,
	) => {
		const rt = runtime?.[entry.session.path];
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
				settled={isSettledPath(entry.session.path)}
				execution={rt?.execution ?? "idle"}
				startedAt={rt?.startedAt}
				branch={
					activePath === entry.session.path ? activeBranch : undefined
				}
				gitStatus={gitStatuses?.[entry.cwd] ?? null}
				onRefreshGitStatus={
					gitStatuses?.[entry.cwd] ? onRefreshGitStatus : undefined
				}
				onOpen={onOpen}
				onPrefetch={onPrefetch}
				onDelete={onDeleteSession}
				onTogglePin={onTogglePin}
				onToggleSnooze={onToggleSnooze}
				onToggleUnread={onToggleUnread}
				onToggleArchive={onToggleArchive}
				onSettle={onSettle}
				onUnsettle={onUnsettle}
				onRename={onRename}
				onCopy={onCopy}
				onCreateHandoff={onCreateHandoff}
				onConsumeHandoff={onConsumeHandoff}
			/>
		);
	};

	return (
		<aside className="flex flex-col app-sidebar shrink-0" style={{ width }}>
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
						const next = Math.min(
							560,
							Math.max(
								220,
								w + (e.key === "ArrowRight" ? 16 : -16),
							),
						);
						localStorage.setItem(
							"babylon:sidebar-width",
							String(next),
						);
						return next;
					});
				}}
				onPointerDown={startResize}
			/>
			<div className="flex gap-2 items-center pr-3 h-11 titlebar shrink-0 pl-[88px]">
				{spaces.length > 1 ? (
					<div className="flex-1 min-w-0">
						<ProjectFilter
							projects={spaces.map((sp) => ({
								cwd: sp.cwd,
								name: projectName(sp.cwd),
							}))}
							value={projectFilter}
							onChange={onProjectFilterChange}
						/>
					</div>
				) : (
					<div className="flex-1 min-w-0" />
				)}
				<button
					onClick={onToggleMinimize}
					title="Minimize sidebar (⌘B)"
					aria-label="Minimize sidebar"
					className="ml-auto sidebar-toggle shrink-0"
				>
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
				<button
					onClick={onOpenTree}
					disabled={!canOpenTree}
					className={`sidebar-action ${treeOpen ? "is-active" : ""}`}
				>
					<BranchIcon size={16} className="sidebar-action-icon" />
					<span>History</span>
				</button>
			</nav>

			<div className="overflow-y-auto flex-1 py-2 px-2.5 min-h-0">
				{spaces.length === 0 ? (
					<div className="py-3 px-3">
						<p className="leading-6 text-[14px] text-dim">
							No spaces yet. Add a project to start.
						</p>
						<button
							type="button"
							onClick={onAddSpace}
							className="py-1.5 px-3 mt-2 font-semibold rounded-lg hover:opacity-90 bg-accent text-[13px] text-bg"
						>
							Add a space
						</button>
					</div>
				) : (
					<>
						<div className="flex gap-1 items-center px-2.5 pt-1 pb-1">
							<span className="shelf-label">
								Spaces
								{spaces.length > 0 ? ` (${spaces.length})` : ""}
							</span>
							<span className="shelf-divider" />
							<button
								type="button"
								onClick={onAddSpace}
								title="Add a space (pick a project folder)"
								className="thread-action thread-action-text text-[12px]"
							>
								Add
							</button>
						</div>
						{spaces.map((sp) => {
							const isActiveSpace = sp.cwd === activeCwd;
							const branch = gitStatuses?.[sp.cwd]?.branch;
							return (
								<div key={sp.cwd}>
									<div
										className={`group/space relative flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 ${isActiveSpace ? "bg-inset" : "hover:bg-raised"}`}
									>
										<button
											type="button"
											onClick={() => openSpace(sp.cwd)}
											title={sp.cwd}
											onMouseEnter={() => {
												onRefreshGitStatus?.(sp.cwd);
												if (
													!isActiveSpace &&
													sp.usable[0]
												)
													onPrefetch?.(
														sp.usable[0].path,
													);
											}}
											aria-current={
												isActiveSpace
													? "true"
													: undefined
											}
											className="flex flex-1 gap-2 items-center min-w-0 text-left"
										>
											<ProjectIcon
												cwd={sp.cwd}
												allCwds={allSpaceCwds}
												size={14}
											/>
											<span className="flex-1 min-w-0 font-semibold truncate text-[13px]">
												{projectName(sp.cwd)}
											</span>
											{branch &&
											branch !== "main" &&
											branch !== "master" ? (
												<span className="max-w-[12ch] shrink-0 truncate text-[11px] text-dim">
													{branch}
												</span>
											) : null}
											{sp.attention === "approval" ? (
												<span
													className="inline-block w-1.5 h-1.5 rounded-full animate-pulse shrink-0 bg-warn"
													title="Needs approval or input"
												/>
											) : sp.attention === "unread" ? (
												<span
													className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--pc)]"
													title="Unread activity"
												/>
											) : sp.live > 0 ? (
												<span
													className="inline-block w-1.5 h-1.5 rounded-full animate-pulse shrink-0 bg-[var(--ok)]"
													title={`${sp.live} running`}
												/>
											) : null}
											<span className="tabular-nums shrink-0 text-[11px] text-dim">
												{sp.usable.length}
											</span>
										</button>
										{!isActiveSpace ? (
											<button
												type="button"
												onClick={() =>
													onRemoveSpace(sp.cwd)
												}
												title={`Remove ${projectName(sp.cwd)} from Spaces (sessions stay on disk and in Search)`}
												aria-label={`Remove ${projectName(sp.cwd)} from Spaces`}
												className="px-1 rounded opacity-0 transition-opacity focus-visible:opacity-100 shrink-0 text-[12px] text-dim group-hover/space:opacity-100 hover:text-err"
											>
												×
											</button>
										) : null}
									</div>
								</div>
							);
						})}

						<div className="mt-2">
							<AgentsSection
								rows={liveAgents}
								activePath={activePath ?? null}
								allCwds={allSpaceCwds}
								onOpen={onOpenLiveAgent}
							/>
						</div>

						{snoozedList.length > 0 && (
							<>
								<button
									type="button"
									onClick={() =>
										setSnoozedExpanded((v) => !v)
									}
									aria-expanded={snoozedExpanded}
									className="sidebar-shelf-toggle"
								>
									<span className="shelf-label">
										{snoozedExpanded
											? "Snoozed"
											: `Snoozed (${snoozedList.length})`}
									</span>
									<span className="shelf-divider" />
									<ChevronIcon
										size={12}
										className={`shelf-chevron transition-transform ${snoozedExpanded ? "rotate-180" : ""}`}
									/>
								</button>
								{snoozedExpanded &&
									snoozedList.map((entry) =>
										renderRow(entry, "snoozed"),
									)}
							</>
						)}

						{settledList.length > 0 && (
							<>
								<button
									type="button"
									onClick={() => {
										setSettledExpanded((v) => !v);
										setSettledShowAll(false);
									}}
									aria-expanded={settledExpanded}
									className="sidebar-shelf-toggle"
								>
									<span className="shelf-label">
										{settledExpanded
											? "Settled"
											: `Settled (${settledList.length})`}
									</span>
									<span className="shelf-divider" />
									<ChevronIcon
										size={12}
										className={`shelf-chevron transition-transform ${settledExpanded ? "rotate-180" : ""}`}
									/>
								</button>
								{settledExpanded &&
									(settledShowAll
										? settledList
										: settledList.slice(0, SETTLED_LIMIT)
									).map((entry) =>
										renderRow(entry, "settled"),
									)}
								{settledExpanded &&
								settledList.length > SETTLED_LIMIT ? (
									<button
										type="button"
										onClick={() =>
											setSettledShowAll((v) => !v)
										}
										className="flex gap-2 items-center py-1 px-2.5 w-full text-left rounded-md text-[12px] text-dim hover:text-fg"
									>
										{settledShowAll
											? "Show less"
											: `Show more (${settledList.length - SETTLED_LIMIT})`}
									</button>
								) : null}
							</>
						)}

						{archivedList.length > 0 && (
							<>
								<button
									type="button"
									onClick={onToggleShowArchived}
									aria-expanded={showArchived}
									className="sidebar-shelf-toggle"
								>
									<span className="shelf-label">
										{showArchived
											? "Archived"
											: `Archived (${archivedList.length})`}
									</span>
									<span className="shelf-divider" />
									<ChevronIcon
										size={12}
										className={`shelf-chevron transition-transform ${showArchived ? "rotate-180" : ""}`}
									/>
								</button>
								{showArchived &&
									archivedList.map((entry) =>
										renderRow(entry, "archived"),
									)}
							</>
						)}
					</>
				)}
			</div>

			<div className="sidebar-footer">
				<button onClick={onOpenFolder} className="sidebar-action">
					<FolderIcon size={16} className="sidebar-action-icon" />
					<span>Open folder…</span>
				</button>
				<button
					type="button"
					onClick={onOpenSettings}
					className="sidebar-action"
					aria-haspopup="dialog"
				>
					<GearIcon size={16} className="sidebar-action-icon" />
					<span>Settings</span>
				</button>
			</div>
		</aside>
	);
});
