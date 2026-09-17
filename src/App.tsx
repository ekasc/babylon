import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { bridge, bridgeAvailable, type ActivityUpdate, type CommandInfo, type HistoryProjection, type ProjectGroup, type ProjectSettings, type SessionMeta, type SessionStatus, type SessionWindow, type WorkflowRunSummary } from "./bridge";
import type { Bot, BotGroup, BotPatch, DefaultBot, NewBotInput, NewGroupInput } from "./bots";
import { isBotMainSession, isGroupRoom } from "./bots";
import { initialState, mergeLiveMessages, reducer } from "./store";
import { shouldAcceptEvent } from "./sessionLifecycle";
import {
  applyRuntimeEvent,
  canSettle,
  computeRuntimeByPath,
  reconcileAfterReconnect,
  resolveApprovalExecution,
  resolveRuntimePath as resolveRuntimePathPure,
  type PathExecutionMap,
  type SessionRuntimeState,
  emptyExecutions,
} from "./sessionRuntime";
import {
  buildAllSpaceCwds,
  buildAttentionByPath,
  buildHistoryEntries,
  buildLiveAgentRows,
  buildMtimeByPath,
  buildSessionByPath,
  buildTabItems,
  resolveSessionTitle,
} from "./app-selectors";
import { insertCommand } from "./commands";
import { countRunningWork } from "./lib/activity";
import Sidebar from "./components/Sidebar";
import { useTheme } from "./components/hooks/useTheme";
import { useRollback } from "./components/hooks/useRollback";
import { useEventLog } from "./components/hooks/useEventLog";
import { useGitStatus } from "./components/hooks/useGitStatus";
import { useSidebarState } from "./components/hooks/useSidebarState";
import { usePanels } from "./components/hooks/usePanels";
import { getNumberWithFallback, getWithFallback, setWithFallback } from "./lib/storage";
import { useBoolPref, useStringPref, writeBoolPref, writeStringPref } from "./lib/prefs";
import ChatView from "./components/ChatView";
import { type Attachment } from "./components/Composer";
import DialogHost from "./components/DialogHost";
import Toasts from "./components/Toasts";
import Hero from "./components/Hero";
import WorkspacePane from "./components/WorkspacePane";
import { RollbackConfirm } from "./components/Rollback";
import NewSessionModal from "./components/NewSessionModal";
import SessionFooter from "./components/SessionFooter";
import { ApprovalGate } from "./components/ApprovalGate";
import GitCommitPopover from "./components/GitCommitPopover";
// Overlay panels are rarely needed at boot; lazy-load them so they stay out
// of the startup bundle.
const SimSidebar = lazy(() => import("./components/SimSidebar").then((m) => ({ default: m.SimSidebar })));
const DiagnosticsPanel = lazy(() => import("./components/DiagnosticsPanel").then((m) => ({ default: m.DiagnosticsPanel })));
import { collectDiagnostics } from "./diagnostics";
import { PromptHost, confirmAction, promptText } from "./lib/prompts";
import { createAttentionRegistry } from "./attention";
import { defaultPolicy } from "./background-policy";
import { createBabylonEvent, type BabylonEvent } from "./events";
import { babylonEventFromAgentEvent } from "./agent-events";
import { stampOwnership } from "./ownership";
import { addAttention, listAttention, removeAttention, type AttentionRegistry } from "./attention";
import { ChevronIcon, GlobeIcon, LayersIcon, GaugeIcon } from "./components/icons";
import { SessionTabs } from "./components/SessionTabs";
import { SessionHistoryMenu } from "./components/SessionHistoryMenu";
import PanelsMenu from "./components/PanelsMenu";
import { GoalOverlay } from "./components/GoalOverlay";
import StatsCard, { defaultStatsCardPos, type StatsCardPos } from "./components/StatsCard";
import { countCompactions, pushTurnSample, type TurnSample } from "./lib/session-stats";
import {
  bumpGoalTurn,
  clearGoal,
  finishGoal,
  loadGoals,
  moveGoal,
  saveGoals,
  startGoal,
  type GoalMap,
} from "./lib/goal-mode";
import {
  addNavTab,
  closeNavTab,
  migrateLegacyTabs,
  pickSpaceTab,
  visibleSpaceTabs,
  type NavTabsBlob,
} from "./lib/nav-model";

const BranchPanel = lazy(() => import("./components/BranchPanel"));
const WorkflowsPanel = lazy(() => import("./components/WorkflowsPanel"));
const CommandPalette = lazy(() => import("./components/CommandPalette"));
// Off-screen until a panel opens; keeping them out of the startup bundle.
const SettingsPage = lazy(() => import("./components/SettingsPage"));
const ProjectPanel = lazy(() => import("./components/ProjectPanel"));

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  // Bot Mode: named specialists with a canonical forever-chat each.
  const [bots, setBots] = useState<Bot[]>([]);
  const [appDefaultBot, setAppDefaultBot] = useState<DefaultBot | null>(null);
  const [showProject, setShowProject] = useState(false);
  // Goal mode: per-session objective with elapsed time + turn count.
  const [goals, setGoals] = useState<GoalMap>(() => loadGoals());
  const [goalOpen, setGoalOpen] = useState(false);
  const updateGoals = useCallback((fn: (m: GoalMap) => GoalMap) => {
    setGoals((prev) => {
      const next = fn(prev);
      if (next !== prev) saveGoals(next);
      return next;
    });
  }, []);
  // Group rooms: one shared session where member bots take serial turns.
  const [botGroups, setBotGroups] = useState<BotGroup[]>([]);
  // Per-project bots: settings snapshot for the active project (default copy,
  // staffed roster, free-speak). Null until loaded; when absent (daemon mode,
  // bridge gaps) the UI keeps today's global behavior.
  const [projectSettings, setProjectSettings] = useState<{ settings: ProjectSettings; hash: string } | null>(null);

  const {
    pinnedOrder,
    setPinnedOrder,
    snoozed,
    archived,
    unread,
    setSettled,
    showArchived,
    setShowArchived,
    settled,
    togglePin,
    toggleSnooze,
    toggleUnread,
    markUnread,
    clearUnread,
    toggleArchive,
    toggleShowArchived,
  } = useSidebarState();
  const copySession = useCallback((kind: "path" | "id" | "branch", session: SessionMeta) => {
    const value =
      kind === "path" ? session.path : kind === "id" ? session.id : session.cwd;
    void navigator.clipboard?.writeText(value);
    toast("info", `Copied ${kind}`);
  }, []);
  const [status, setStatus] = useState<SessionStatus>({ status: "idle" });
  const [projectFilter, setProjectFilter] = useState("all");
  // Global session working set (browser model): open tabs in insertion
  // order, independent of Space. v2 blob {tabs, activeBySpace}; the legacy
  // per-space record shape migrates on load. Closing never deletes.
  const [navTabs, setNavTabs] = useState<NavTabsBlob>(() => {
    try {
      return migrateLegacyTabs(JSON.parse(localStorage.getItem("babylon:tabs") ?? "null"), []);
    } catch {
      return { tabs: [], activeBySpace: {} };
    }
  });
  const persistTabs = (blob: NavTabsBlob) =>
    localStorage.setItem("babylon:tabs", JSON.stringify(blob));
  // Explicit project context. Follows opened sessions; space selection sets
  // it directly (a space can be active with no session open — landing).
  const [activeSpace, setActiveSpaceState] = useState<string | null>(() =>
    localStorage.getItem("babylon:active-space")
  );
  const setActiveSpace = useCallback((cwd: string | null) => {
    setActiveSpaceState(cwd);
    if (cwd) localStorage.setItem("babylon:active-space", cwd);
    else localStorage.removeItem("babylon:active-space");
  }, []);
  // Pre-warm a project the moment it becomes the active space: the rollback
  // shadow index and the project's model runtime are built while the user is
  // reading, so the first session open (and the first send in it) is not cold.
  useEffect(() => {
    if (activeSpace) void bridge.warmProject(activeSpace).catch(() => undefined);
  }, [activeSpace]);
  // Single choke point for a successfully opened session: register the tab
  // (no reorder), remember it per space, adopt its project context.
  const registerOpenSession = useCallback((cwd: string, path: string) => {
    setNavTabs((prev) => {
      const tabs = addNavTab(prev.tabs, cwd, path);
      const next = { tabs, activeBySpace: { ...prev.activeBySpace, [cwd]: path } };
      persistTabs(next);
      return next;
    });
    setActiveSpace(cwd);
  }, [setActiveSpace]);

  const [models, setModels] = useState<any[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { themePref, themeId, setThemePref, setThemeId } = useTheme();
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [agentState, setAgentState] = useState<any>(null);
  const { gitStatuses, refreshGitStatuses, refreshGitStatusForCwd } = useGitStatus(groups);
  const [stats, setStats] = useState<any>(null);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const {
    showBranchPanel,
    setShowBranchPanel,
    showCommitPopover,
    setShowCommitPopover,
    showWorkflowsPanel,
    setShowWorkflowsPanel,
    showSimPanel,
    setShowSimPanel,
    showCommandPalette,
    setShowCommandPalette,
    panelsMenuOpen,
    setPanelsMenuOpen,
    showDiagnostics,
    setShowDiagnostics,
  } = usePanels();
  const [attention, setAttention] = useState<AttentionRegistry>(() =>
    createAttentionRegistry(),
  );
  const { eventLog, appendEvents } = useEventLog(showDiagnostics);
  // Non-streaming is the default: hold incremental text until the reply is
  // complete. (Reasoning always renders as one collapsed line.)
  const streamResponses = useBoolPref("streamResponses", false);
  // Optional floating session-stats card, off by default. Its position is a
  // shared pref (the card is an instrument, not a per-session artifact).
  const statsCardOpen = useBoolPref("statsCard", false);
  const statsCardPosPref = useStringPref("statsCardPos", "");
  const statsCardPos = useMemo<StatsCardPos>(() => {
    const [x, y] = statsCardPosPref.split(",").map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : defaultStatsCardPos();
  }, [statsCardPosPref]);
  const [turnSamples, setTurnSamples] = useState<{ path: string | null; samples: TurnSample[] }>({
    path: null,
    samples: [],
  });
  const turnStartRef = useRef<{ path: string; at: number } | null>(null);
  // Chat text size: three isolated knobs (message / composer input / code).
  // Applied to <html> so they cover portalled UI too.
  const chatFont = useStringPref("chatFont", "14");
  const promptFont = useStringPref("promptFont", "14");
  const codeFont = useStringPref("codeFont", "13");
  useEffect(() => {
    const px = (v: string, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const root = document.documentElement.style;
    root.setProperty("--chat-font", `${px(chatFont, 14)}px`);
    root.setProperty("--prompt-font", `${px(promptFont, 14)}px`);
    root.setProperty("--code-font", `${px(codeFont, 13)}px`);
  }, [chatFont, promptFont, codeFont]);

  const [history, setHistory] = useState<HistoryProjection>({ turns: [], leafId: null, hasBranches: false });
  const [historyRevision, setHistoryRevision] = useState(0);
  const [contextWidth, setContextWidth] = useState(() => {
    const stored = getNumberWithFallback("context-width", NaN);
    return Number.isFinite(stored) && stored >= 360 && stored <= 1100 ? stored : 520;
  });

  const [sidebarMinimized, setSidebarMinimized] = useState(() => getWithFallback("sidebar-minimized") === "1");
  const [draftRequest, setDraftRequest] = useState<{ id: number; text: string } | null>(null);
  const [promotedParent, setPromotedParent] = useState<{ path: string; cwd: string } | null>(null);
  // Optimistic active session: set synchronously on click so the sidebar row
  // highlights instantly; the host's status confirm later keeps it exact.
  const [activeSessionPath, setActiveSessionPath] = useState<string | null>(null);

  // Optimistic header title: shown instantly from the clicked row, replaced by
  // the host's sessionName when it hydrates.
  const [headerName, setHeaderName] = useState<string | null>(null);
  // "Preparing…" only appears if the host stays not-ready past a beat, fast
  // switches (now <100ms) never flash it; cold first-opens still get the hint.
  const [preparingVisible, setPreparingVisible] = useState(false);
  // True while a sent message is queued behind a cold session open (message
  // already on screen; the turn has not started).
  const [preparingTurn, setPreparingTurn] = useState(false);
  // Whether a stored-transcript window older than the current one exists.
  const [canLoadMore, setCanLoadMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [activity, setActivity] = useState<ActivityUpdate>({ threads: [], subagents: [] });
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSummary[]>([]);
  // `hasSession` = a session's content is on screen (preview or live).
  // `liveReady` = the pi process is live on that session. Opening a session
  // flips hasSession immediately (instant file preview); liveReady follows
  // once the in-process switch completes, no Hero flash, no blocking.
  const [hasSession, setHasSession] = useState(false);
  const [liveReady, setLiveReady] = useState(false);

  // Debounce the "Preparing…" indicator: show it only when the host has been
  // not-ready for >250ms (cold first-opens), so sub-100ms switches never flash it.
  useEffect(() => {
    if (liveReady) {
      setPreparingVisible(false);
      return;
    }
    if (!hasSession) {
      setPreparingVisible(false);
      return;
    }
    const timer = setTimeout(() => setPreparingVisible(true), 250);
    return () => clearTimeout(timer);
  }, [liveReady, hasSession]);
  // The epoch of the session currently on screen. Agent events are tagged with
  // the epoch captured when they start; events from a stale (previous) session
  // are dropped so streams can't bleed into a freshly-opened transcript.
  const epochRef = useRef(0);
  const latestRequestRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const switchingRef = useRef(false);
  const liveReadyRef = useRef(false);
  const activePathRef = useRef<string | null>(null);
  // Event-driven execution per session path (all sessions, not just the open
  // one). Updated from every agent event batch; keyed by path so background
  // runs survive navigation and switching never redefines what is alive.
  const [executions, setExecutions] = useState<PathExecutionMap>(emptyExecutions);
  // Monotonic receive sequence: older-or-equal events are stale and ignored,
  // so delayed duplicates can never resurrect cleared activity.
  const runtimeSeqRef = useRef(0);
  // sessionId -> path for every known session; mirrors groups each render.
  const sessionIdToPathRef = useRef(new Map<string, string>());
  // Stored-transcript windows: the messages currently in view plus the byte
  // offset of the oldest loaded one, so scrolling to the top streams exactly
  // the preceding window instead of the whole file. The transcript only ever
  // grows (older windows prepend, live messages append), never shrinks, which
  // is what keeps big-session opens free of wipe-flicker.
  const loadedMessagesRef = useRef<any[]>([]);
  const earliestOffsetRef = useRef<number | null>(null);
  const loadingMoreRef = useRef(false);
  // Per-session transcript cache (bounded LRU, opencode's SESSION_CACHE
  // pattern): switching back renders from memory instead of re-reading the
  // file, and the host re-warms in the background.
  const sessionCacheRef = useRef(new Map<string, { messages: any[]; earliestOffset: number | null; canLoadMore: boolean }>());
  const prefetchingRef = useRef(new Set<string>());
  const streamingRef = useRef(false);
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;
  const hasSessionRef = useRef(false);
  const rollbackDraftRef = useRef<string | null>(null);
  useEffect(() => { hasSessionRef.current = hasSession; }, [hasSession]);
  useEffect(() => { liveReadyRef.current = liveReady; }, [liveReady]);
  useEffect(() => { streamingRef.current = state.streaming; }, [state.streaming]);

  const toast = useCallback(
    (type: "info" | "warning" | "error", text: string) =>
      dispatch({ type: "toast", toast: { type, text } }),
    []
  );

  // Stable identity so the memoized Sidebar does not re-render every frame.
  const renameSession = useCallback(
    async (path: string) => {
      const name = await promptText({ title: "Rename chat", prefill: headerName ?? undefined, placeholder: "Session name" });
      if (!name) return;
      if (path === activeSessionPath) {
        void bridge.setSessionName(name);
        return;
      }
      toast("info", "Open the chat to rename it");
    },
    [headerName, activeSessionPath, toast]
  );

  // Ref mirror so menu callbacks read fresh execution without re-creating
  // on every runtime tick (Sidebar rows are memoized on handler identity).
  const runtimeByPathRef = useRef<Record<string, SessionRuntimeState>>({});
  const groupsRef = useRef<ProjectGroup[]>([]);
  const closeTabRef = useRef<(path: string) => void>(() => {});
  // Failed-transition attention: a thread/subagent that newly reports
  // interrupted/failed marks its owning sessions unread. Only transitions
  // observed while running count (seeded silently), so restarts and old
  // history never manufacture attention. Clears on view like any unread.
  const failedSeenRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const FAILED = new Set(["interrupted", "failed"]);
    const check = (
      items: Array<{ status: string; sessionFile?: string | null; parentSessionFile?: string | null }>,
      idOf: (item: (typeof items)[number]) => string
    ) => {
      for (const item of items) {
        const id = idOf(item);
        const prev = failedSeenRef.current.get(id);
        failedSeenRef.current.set(id, item.status);
        if (prev === undefined) continue;
        if (!FAILED.has(item.status) || FAILED.has(prev)) continue;
        for (const p of [item.sessionFile, item.parentSessionFile]) {
          if (p) markUnread(p);
        }
      }
    };
    check(activity.threads, (t: any) => `thread:${t.threadId}`);
    check(activity.subagents, (s: any) => `subagent:${s.runId}`);
  }, [activity, markUnread]);
  // Explicit settlement: idle (or failed) sessions leave active work for the
  // Settled shelf; live work (working/waiting/approval) rejects. Persisted.
  // Settling the open session is allowed when idle: it persists, drops its
  // tab, and falls back to a neighbor tab (or stays viewing the settled
  // transcript when nothing else is open — viewing settled work is legal).
  const settleSession = useCallback((path: string) => {
    const exec = runtimeByPathRef.current[path]?.execution ?? "idle";
    if (!canSettle(exec)) {
      toast("warning", "Still working — settle after this run finishes");
      return;
    }
    setSettled((prev) => {
      if (prev[path] != null) return prev;
      const next = { ...prev, [path]: Date.now() };
      localStorage.setItem("babylon:settled", JSON.stringify(next));
      return next;
    });
    // Settled work leaves tabs and pins behind (like archive drops its pin).
    setPinnedOrder((prev) => {
      if (!prev.includes(path)) return prev;
      const next = prev.filter((p) => p !== path);
      localStorage.setItem("babylon:pinned", JSON.stringify(next));
      return next;
    });
    const cwd = runtimeByPathRef.current[path]?.cwd;
    setNavTabs((prev) => {
      if (!prev.tabs.some((t) => t.path === path)) return prev;
      const next = { ...prev, tabs: prev.tabs.filter((t) => t.path !== path) };
      persistTabs(next);
      return next;
    });
    if (path === activePathRef.current && cwd) closeTabRef.current(path);
  }, [toast]);
  const unsettleSession = useCallback((path: string) => {
    setSettled((prev) => {
      if (prev[path] == null) return prev;
      const next = { ...prev };
      delete next[path];
      localStorage.setItem("babylon:settled", JSON.stringify(next));
      return next;
    });
    // Return to active work means visible work: re-add its tab under the
    // owning project (opening the row un-settles the same way).
    const owner = groupsRef.current
      .flatMap((g) => g.sessions.map((s) => ({ ...s, groupCwd: g.cwd })))
      .find((s) => s.path === path);
    if (owner) {
      setNavTabs((prev) => {
        const tabs = addNavTab(prev.tabs, owner.groupCwd, path);
        if (tabs === prev.tabs) return prev;
        const next = { ...prev, tabs };
        persistTabs(next);
        return next;
      });
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      setGroups(await bridge.listSessions());
    } catch {
      /* sessions dir may not exist yet */
    }
  }, []);

  const togglePalette = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    const apply = () => setShowCommandPalette(next as any);
    const doc: any = document as any;
    // Rapid ⌘K cycling skips the in-flight transition, which rejects its
    // promises: observe and swallow so fast navigation stays console-clean.
    if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      try {
        const transition = doc.startViewTransition(apply);
        // A newer transition (or snapshot skip) rejects every pending
        // promise on the old one; observe them all so fast navigation
        // never surfaces an unhandled AbortError.
        for (const key of ["ready", "updateCallbackDone", "finished"] as const) {
          try {
            (transition as any)?.[key]?.catch?.(() => {});
          } catch {
            /* ignore */
          }
        }
        return;
      } catch {
        /* fall through to the instant path */
      }
    }
    apply();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
        togglePalette((open: boolean) => !open);
      } else if (command && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarMinimized((minimized) => {
          setWithFallback("sidebar-minimized", minimized ? "0" : "1");
          return !minimized;
        });
      } else if (command && event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setShowWorkflowsPanel((open) => !open);
        setShowBranchPanel(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const beginContextResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    // Start from what is actually on screen, not a stored width that CSS may
    // have clamped for this viewport.
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? contextWidth;
    const maxWidth = Math.max(360, Math.min(1100, window.innerWidth - 120));
    document.documentElement.classList.add("is-context-resizing");

    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("blur", finish);
      document.documentElement.classList.remove("is-context-resizing");
      setContextWidth((width) => {
        setWithFallback("context-width", String(width));
        return width;
      });
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      setContextWidth(Math.max(360, Math.min(maxWidth, startWidth + startX - move.clientX)));
    };
    const onEnd = (end: PointerEvent) => {
      if (end.pointerId === pointerId) finish();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("blur", finish);
  }, [contextWidth]);

  useEffect(() => {
    const offActivity = bridge.onActivityUpdate(setActivity);
    const offWorkflows = bridge.onWorkflowsUpdate((update) => setWorkflowRuns(update.runs));
    // The agent opening the in-app browser takes over the context pane.
    const offSim = bridge.onSimEvent((ev) => {
      if (ev.type === "visibility" && ev.open) {
        setShowSimPanel(true);
        setShowBranchPanel(false);
        setShowWorkflowsPanel(false);
      }
    });
    return () => {
      offActivity();
      offWorkflows();
      offSim();
    };
  }, []);

  // Bot Mode roster: initial load + live push from the main-process store.
  useEffect(() => {
    bridge.botsList().then(setBots).catch(() => undefined);
    bridge.botsDefaultGet().then(setAppDefaultBot).catch(() => undefined);
    return bridge.onBotsUpdate(setBots);
  }, []);
  useEffect(() => {
    bridge.groupsList().then(setBotGroups).catch(() => undefined);
    return bridge.onGroupsUpdate(setBotGroups);
  }, []);
  useEffect(() => {
    const cwd = status.cwd;
    if (!cwd) {
      setProjectSettings(null);
      return;
    }
    let live = true;
    bridge
      .projectSettingsGet(cwd)
      .then((v) => {
        if (live) setProjectSettings(v);
      })
      .catch(() => {
        if (live) setProjectSettings(null);
      });
    return () => {
      live = false;
    };
  }, [status.cwd]);

  // Attention Inbox: raise an item when the agent needs the user (here, a
  // permission request). The id is keyed to the approval id so repeats of the
  // same request do not create duplicates. The user dismisses from the inbox.
  // Shared approval registration: live requests and post-reload recovery of
  // still-pending runtime approvals take the same path (inbox item + event).
  const registerApproval = useCallback(
    (req: { id: string; action: { description?: string; category?: string }; risk?: unknown }, source?: string | null) => {
      appendEvents([createBabylonEvent("approval.requested", { payload: { id: req.id } })]);
      setAttention((prev) =>
        addAttention(prev, {
          id: `perm-${req.id}`,
          type: "permission",
          title: "Approval required",
          detail: req.action.description ?? req.action.category,
          source: source ?? activeSessionPath ?? status.sessionPath ?? undefined,
          createdAt: Date.now(),
          resolved: false,
        })
      );
    },
    [activeSessionPath, status.sessionPath, appendEvents]
  );
  useEffect(() => {
    return bridge.onApprovalRequested((req) => {
      registerApproval(req);
      // The gated run is live on the active session: reflect approval in the
      // canonical execution so rows/dock agree while it waits.
      const ap = activePathRef.current;
      if (ap) {
        const seq = ++runtimeSeqRef.current;
        setExecutions((prev) => applyRuntimeEvent(prev, { type: "extension_ui_request" }, { path: ap, seq, now: Date.now() }));
      }
    });
  }, [registerApproval]);

  // Recovery after renderer reload: the runtime may still wait on approvals
  // whose request events died with the old renderer. Runs on mount and
  // whenever the session index arrives (path resolution needs groups):
  // inbox items always, execution marking when the owning session resolves.
  // Dialogs restore only on open (phase two below) — never hijack another
  // session's composer.
  const recoveredApprovalsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    bridge
      .approvalsPending()
      .then((pending) => {
        if (!live) return;
        for (const req of pending ?? []) {
          // Inbox restores exactly once; execution marking retries on every
          // run until the session index can resolve the owner.
          if (!recoveredApprovalsRef.current.has(`inbox-${req.id}`)) {
            recoveredApprovalsRef.current.add(`inbox-${req.id}`);
            registerApproval(req);
          }
          if (recoveredApprovalsRef.current.has(`exec-${req.id}`)) continue;
          const sid = (req as { sessionId?: string | null }).sessionId ?? null;
          const path = sid ? sessionIdToPathRef.current.get(sid) ?? null : null;
          if (!path) continue;
          recoveredApprovalsRef.current.add(`exec-${req.id}`);
          const at = Date.now();
          const seq = ++runtimeSeqRef.current;
          setExecutions((prev) => applyRuntimeEvent(prev, { type: "extension_ui_request" }, { path, seq, now: at }));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [registerApproval, groups]);

  // Phase two of approval recovery: after a session opens, restore any of
  // its still-pending requests as live dialogs + execution state.
  const restoreApprovalsForSession = useCallback(
    (path: string) => {
      bridge
        .approvalsPending()
        .then((pending) => {
          for (const req of pending ?? []) {
            const reqSessionId = (req as { sessionId?: string | null }).sessionId ?? null;
            const resolved = reqSessionId ? (sessionIdToPathRef.current.get(reqSessionId) ?? null) : path;
            if (resolved !== path) continue;
            if (recoveredApprovalsRef.current.has(`dialog-${req.id}`)) continue;
            recoveredApprovalsRef.current.add(`dialog-${req.id}`);
            dispatch({
              type: "event",
              event: {
                type: "extension_ui_request",
                id: req.id,
                method: "confirm",
                title: "Approval required",
                message: req.action?.description ?? req.action?.category ?? "The agent is waiting for approval.",
              } as any,
            });
            const at = Date.now();
            const seq = ++runtimeSeqRef.current;
            setExecutions((prev) => applyRuntimeEvent(prev, { type: "extension_ui_request" }, { path, seq, now: at }));
          }
        })
        .catch(() => undefined);
    },
    []
  );

  // Daemon socket transitions: on loss, warn (calls already fail fast with
  // explicit errors); on reconnect, drop everything but the active entry —
  // the singleton runtime means nothing else can still be executing — and
  // refresh host truth plus the aggregate activity snapshot.
  useEffect(() => {
    return bridge.onDaemonStatus(({ connected }) => {
      if (!connected) {
        toast("warning", "Pi runtime disconnected — reconnecting…");
        return;
      }
      toast("info", "Pi runtime reconnected");
      setExecutions((prev) => reconcileAfterReconnect(prev, activePathRef.current));
      bridge.getState().then(setAgentState).catch(() => undefined);
      bridge
        .activityList()
        .then(setActivity)
        .catch(() => undefined);
    });
  }, [toast]);

  // Drop the matching attention item when the approval is actually resolved
  // (allowed or denied), so the inbox stops over-reporting outstanding work.
  // The gated run resumes, so the canonical execution returns to working.
  // Resolution targets the APPROVAL's session (which may be backgrounded),
  // never blindly the foreground session.
  useEffect(() => {
    return bridge.onApprovalResolved((payload) => {
      appendEvents([
        createBabylonEvent("approval.resolved", {
          payload: { id: payload.id, decision: payload.choice },
        }),
      ]);
      setAttention((prev) => removeAttention(prev, `perm-${payload.id}`));
      const sid = (payload as { sessionId?: string | null }).sessionId ?? null;
      const ap = (sid && sessionIdToPathRef.current.get(sid)) || activePathRef.current;
      if (ap) {
        const seq = ++runtimeSeqRef.current;
        const at = Date.now();
        setExecutions((prev) => resolveApprovalExecution(prev, ap, seq, at));
      }
    });
  }, [appendEvents]);

  // Attention lifecycle events: diff committed registry state so every real
  // transition (permission raises, automation failures, dismissals, clears)
  // is observed exactly once, regardless of which surface caused it. The
  // attention item id is the subject; no owner ids are fabricated.
  const prevAttentionRef = useRef(attention);
  useEffect(() => {
    const prev = prevAttentionRef.current;
    prevAttentionRef.current = attention;
    if (prev === attention) return;
    const events: BabylonEvent[] = [];
    for (const id of Object.keys(attention.items)) {
      if (!prev.items[id]) events.push(createBabylonEvent("attention.created", { payload: { id } }));
    }
    for (const id of Object.keys(prev.items)) {
      if (!attention.items[id]) events.push(createBabylonEvent("attention.resolved", { payload: { id } }));
    }
    appendEvents(events);
  }, [attention, appendEvents]);

  useEffect(() => {
    if (status.status !== "ready") return;
    void Promise.all([bridge.activityList(), bridge.workflowsList()])
      .then(([nextActivity, nextRuns]) => {
        setActivity(nextActivity);
        setWorkflowRuns(nextRuns);
      })
      .catch(() => undefined);
  }, [status.status, status.cwd]);

  useEffect(() => {
    void refreshSessions();
    return bridge.onSessionsUpdate((update) => {
      setGroups(update.groups);
      const activePath = activePathRef.current;
      if (
        update.source !== "host" &&
        activePath &&
        update.changedPaths.includes(activePath) &&
        !streamingRef.current &&
        !switchingRef.current
      ) {
        // Background refresh must never clear the active session id: the
        // false path (turn running, nothing to pull) emits no status, so a
        // cleared id would blackhole the whole turn's events (every agent
        // event carries sessionId) until the next explicit open.
        switchingRef.current = true;
        void bridge
          .refreshSession(activePath)
          .then((refreshed) => {
            if (!refreshed) switchingRef.current = false;
          })
          .catch(() => {
            switchingRef.current = false;
          });
      }
    });
  }, [refreshSessions]);

  // Poll the active session file when it's being driven by the CLI (GUI not streaming).
  // The SessionIndex watch (300ms) + safety scan (2s) should catch most changes, but
  // a direct poll ensures sub-second live updates when the CLI is streaming.
  useEffect(() => {
    const activePath = activeSessionPath ?? status.sessionPath;
    if (!activePath || streamingRef.current || switchingRef.current) return;
    const id = window.setInterval(() => {
      const current = activePathRef.current;
      if (!current || streamingRef.current || switchingRef.current) return;
      // See above: never clear the active session id here. A refresh that
      // returns false emits no status, so clearing would drop every later
      // agent event for the live session (blackholed turn, no indicator).
      switchingRef.current = true;
      void bridge
        .refreshSession(current)
        .then((refreshed) => {
          if (!refreshed) switchingRef.current = false;
        })
        .catch(() => {
          switchingRef.current = false;
        });
    }, 1000);
    return () => window.clearInterval(id);
  }, [activeSessionPath, status.sessionPath, hasSession]);

  // Resync from the source of truth. Manual compaction doesn't fire
  // a run-end event, so without this the StatsPopover context % and the
  // transcript would stay at the pre-compaction values until the next
  // user prompt.
  const resyncFromSource = useCallback(async (opts?: { skipRefresh?: boolean }) => {
    const expectedEpoch = epochRef.current;
    try {
      const activePath = activePathRef.current;
      if (!opts?.skipRefresh && activePath && (await bridge.refreshSession(activePath))) return;
      const [msgs, st, statsData, nextHistory] = await Promise.all([
        bridge.getMessages(),
        bridge.getState(),
        bridge.getStats(),
        bridge.getHistory(),
      ]);
      if (expectedEpoch !== epochRef.current) return;
      dispatch({ type: "rebuild", messages: msgs });
      setAgentState(st);
      setStats(statsData);
      setHistory(nextHistory);
      setHistoryRevision((revision) => revision + 1);
      const rollbackCreatedAt = nextHistory.activeRollback?.createdAt ?? null;
      if (rollbackCreatedAt && rollbackDraftRef.current !== rollbackCreatedAt) {
        rollbackDraftRef.current = rollbackCreatedAt;
        setDraftRequest({ id: Date.now(), text: nextHistory.activeRollback!.editorText });
      } else if (!rollbackCreatedAt) {
        rollbackDraftRef.current = null;
      }
      void refreshSessions();
    } catch {
      /* session may have closed */
    }
  }, [refreshSessions]);

  // When a run settles, resync from the source of truth.
  useEffect(() => {
    if (!state.settledNonce) return;
    void resyncFromSource();
  }, [state.settledNonce, resyncFromSource]);

  // sessionId -> path mirror for resolving background events to rows.
  useEffect(() => {
    const m = new Map<string, string>();
    for (const g of groups) for (const s of g.sessions) m.set(s.id, s.path);
    sessionIdToPathRef.current = m;
  }, [groups]);

  // Resolve an agent event to the session path it describes (pure helper in
  // sessionRuntime; lifecycle events require a known session so stale or
  // foreign ids can never resurrect activity on the open session).
  const resolveRuntimePath = useCallback(
    (sessionId?: string | null, requireKnown = false): string | null =>
      resolveRuntimePathPure(
        sessionId ?? null,
        activeSessionIdRef.current,
        sessionIdToPathRef.current,
        activePathRef.current,
        requireKnown
      ),
    []
  );

  useEffect(
    () =>
      bridge.onAgentEvents((events) => {
        if (!hasSessionRef.current) return;
        const context = {
          activeSessionId: activeSessionIdRef.current,
          switching: switchingRef.current,
        };
        let stateChanged = false;
        const mapped: BabylonEvent[] = [];
        let needsResync = false;
        for (const event of events) {
          // Non-streaming (default): suppress incremental text/thinking deltas;
          // the completed blocks are rendered on message_end.
          if (event?.type !== "message_update" || streamResponsesRef.current) {
            if (shouldAcceptEvent(event, context)) dispatch({ type: "event", event });
          }
          // Goal mode: one assistant reply is one turn, on any session with an open goal.
          if (event?.type === "message_end" && (event as any)?.message?.role === "assistant") {
            const sid = typeof (event as any)?.sessionId === "string" ? ((event as any).sessionId as string) : null;
            const rp = resolveRuntimePath(sid, false);
            if (rp) updateGoals((m) => bumpGoalTurn(m, rp));
          }
          // Session stats: bracket each assistant call (message_start ->
          // message_end) and divide its reported output tokens by that wall
          // time. Only the session on screen contributes, so TPS never leaks
          // across a switch. message_end is the authoritative usage carrier:
          // non-streaming suppresses the deltas but not the final message.
          if ((event as any)?.message?.role === "assistant") {
            const sid = typeof (event as any)?.sessionId === "string" ? ((event as any).sessionId as string) : null;
            const rp = resolveRuntimePath(sid, false);
            if (rp && rp === activePathRef.current) {
              if (event?.type === "message_start") {
                turnStartRef.current = { path: rp, at: Date.now() };
              } else if (event?.type === "message_end") {
                const start = turnStartRef.current;
                turnStartRef.current = null;
                if (start?.path === rp) {
                  const outputTokens = Number((event as any)?.message?.usage?.output) || 0;
                  const ms = Date.now() - start.at;
                  if (outputTokens > 0 && ms > 0) {
                    setTurnSamples((prev) => ({
                      path: rp,
                      samples: pushTurnSample(prev.path === rp ? prev.samples : [], { outputTokens, ms }),
                    }));
                  }
                }
              }
            }
          }
          // Canonical runtime feed: every session, not just the open one.
          // Transcript filtering above stays untouched; this map is what the
          // sidebar, Space dots, header, and Agents dock all read.
          if (
            event?.type === "agent_start" ||
            event?.type === "agent_settled" ||
            event?.type === "agent_end" ||
            event?.type === "extension_ui_request" ||
            event?.type === "extension_ui_cancel" ||
            event?.type === "extension_ui_response"
          ) {
            const sid = typeof event?.sessionId === "string" ? (event.sessionId as string) : null;
            const lifecycle = event?.type === "agent_start" || event?.type === "agent_settled" || event?.type === "agent_end";
            const rp = resolveRuntimePath(sid, lifecycle);
            if (rp) {
              const seq = ++runtimeSeqRef.current;
              const at = Date.now();
              setExecutions((prev) => applyRuntimeEvent(prev, event, { path: rp, seq, now: at }));
              // A run that finishes while you look elsewhere is unread work.
              if (
                (event?.type === "agent_settled" || event?.type === "agent_end") &&
                rp !== activePathRef.current
              ) {
                markUnread(rp);
              }
            }
          }
          const babylonEvent = babylonEventFromAgentEvent(event);
          if (babylonEvent) mapped.push(babylonEvent);
          if (
            event?.type === "agent_settled" ||
            event?.type === "agent_end" ||
            event?.type === "session_info_changed"
          ) {
            stateChanged = true;
          }
          if (event?.type === "compaction_end" && !event.aborted) {
            // Manual compact (and any successful compaction) replaces the
            // live session messages with a compacted view. No run-end event
            // fires here, so refresh the transcript, stats, and
            // state ourselves to drop the now-stale items.
            needsResync = true;
          }
        }
        appendEvents(mapped);
        // Reflect engine-side state changes (model/thinking toggles, /fast,
        // session renames) in the status bar without waiting for the next
        // model/thinking/compact round-trip.
        if (stateChanged) bridge.getState().then(setAgentState).catch(() => {});
        if (needsResync) void resyncFromSource({ skipRefresh: true });
      }),
    [appendEvents, resyncFromSource, resolveRuntimePath, markUnread, updateGoals]
  );

  const hydrate = useCallback(async (expectedEpoch = epochRef.current) => {
    try {
      const [msgs, ms, commandData, st, statsData, nextHistory] = await Promise.all([
        bridge.getMessages(),
        bridge.getModels(),
        bridge.getCommands(),
        bridge.getState(),
        bridge.getStats(),
        bridge.getHistory(),
      ]);
      if (expectedEpoch !== epochRef.current) return;
      // Never wipe the on-screen transcript: append only live messages newer
      // than the last loaded one. This is what keeps big-session opens stable
      // (the live compacted view no longer replaces the file tail).
      loadedMessagesRef.current = mergeLiveMessages(loadedMessagesRef.current, msgs);
      dispatch({ type: "rebuild", messages: loadedMessagesRef.current });
      setCanLoadMore(earliestOffsetRef.current != null && earliestOffsetRef.current > 0);
      setModels(ms ?? []);
      setCommands(commandData ?? []);
      if (!commandData?.length) {
        const retryEpoch = expectedEpoch;
        let attempts = 6;
        const retry = async () => {
          if (retryEpoch !== epochRef.current) return;
          if (attempts-- <= 0) return;
          await new Promise<void>((r) => setTimeout(r, 400));
          if (retryEpoch !== epochRef.current) return;
          try {
            const refreshed = await bridge.getCommands();
            if (retryEpoch !== epochRef.current) return;
            if (refreshed?.length) {
              setCommands(refreshed);
              return;
            }
          } catch {
            /* transient, retry until bound */
          }
          if (attempts > 0) void retry();
        };
        void retry();
      }
      setAgentState(st);
      setStats(statsData);
      setHistory(nextHistory);
      setHistoryRevision((revision) => revision + 1);
      const rollbackCreatedAt = nextHistory.activeRollback?.createdAt ?? null;
      if (rollbackCreatedAt && rollbackDraftRef.current !== rollbackCreatedAt) {
        rollbackDraftRef.current = rollbackCreatedAt;
        setDraftRequest({ id: Date.now(), text: nextHistory.activeRollback!.editorText });
      } else if (!rollbackCreatedAt) {
        rollbackDraftRef.current = null;
      }
      void bridge.getThinkingLevels().then(setThinkingLevels).catch(() => undefined);
    } catch (e: any) {
      toast("error", e?.message ?? "failed to load session");
    }
  }, [toast]);

  const { rollbackPlan, rollbackBusy, setRollbackPlan, prepareRollback, commitRollback, undoRollback } = useRollback({
    setHistory,
    setHistoryRevision,
    setDraftRequest,
    hydrate,
    toast,
  });

  useEffect(
    () =>
      bridge.onStatus((s) => {
        if (s.requestId !== undefined && s.requestId !== latestRequestRef.current) return;
        setStatus(s);
        if (s.status === "ready") {
          switchingRef.current = false;
          liveReadyRef.current = true;
          activeSessionIdRef.current = s.state?.sessionId ?? null;
          activePathRef.current = s.sessionPath ?? s.state?.sessionFile ?? activePathRef.current;
          setActiveSessionPath(activePathRef.current);
          setLiveReady(true);
          if (s.sessionPath && s.cwd) registerOpenSession(s.cwd, s.sessionPath);
          void hydrate(epochRef.current);
          // Approval recovery phase two: a still-pending request for this
          // session rebuilds its dialog + execution marking (no hijack of
          // other sessions; background approvals stay inbox-only).
          if (s.sessionPath) restoreApprovalsForSession(s.sessionPath);
        } else if (s.status === "starting") {
          liveReadyRef.current = false;
          setLiveReady(false);
        } else if (s.status === "exited" || s.status === "error") {
          switchingRef.current = false;
          liveReadyRef.current = false;
          setLiveReady(false);
        }
        if (s.status === "error" && s.message) toast("error", s.message);
      }),
    [hydrate, toast, restoreApprovalsForSession]
  );

  // Git status keyed by project cwd is owned by useGitStatus.
  // Predictive fetch (kills the serial IPC from the click path): hovering a
  // sidebar row warms its tail into the LRU cache, so a click is a fully
  // synchronous swap, no await, one batched paint.
  const prefetchSession = useCallback((path: string) => {
    const cache = sessionCacheRef.current;
    if (cache.has(path) || prefetchingRef.current.has(path)) return;
    prefetchingRef.current.add(path);
    bridge
      .getSessionMessages(path)
      .then((window) => {
        prefetchingRef.current.delete(path);
        cache.delete(path);
        cache.set(path, { messages: window.messages, earliestOffset: window.startOffset, canLoadMore: window.startOffset > 0 });
        while (cache.size > 6) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      })
      .catch(() => prefetchingRef.current.delete(path));
  }, []);

  // Bot Mode: the bot whose canonical chat is on screen, if any. Drives the
  // header badge (a bot's chat is forever: reopening it resumes the same file).
  const activeBot: Bot | null = useMemo(() => {
    const file = activeSessionPath ?? status.sessionPath ?? null;
    if (!file) return null;
    return (
      bots.find(
        (b) =>
          (b.sessionsByProject ? Object.values(b.sessionsByProject).includes(file) : false) ||
          isBotMainSession(b, file)
      ) ?? null
    );
  }, [bots, activeSessionPath, status.sessionPath]);
  // Staffed extras for the active project (null = unknown: keep global behavior).
  const sharedStaff = useMemo(() => {
    if (!projectSettings) return null;
    return projectSettings.settings.memberIds
      .map((id) => bots.find((b) => b.id === id))
      .filter((b): b is Bot => !!b);
  }, [projectSettings, bots]);
  const activeGroup: BotGroup | null = useMemo(() => {
    const file = activeSessionPath ?? status.sessionPath ?? null;
    if (!file) return null;
    return botGroups.find((g) => isGroupRoom(g, file)) ?? null;
  }, [botGroups, activeSessionPath, status.sessionPath]);
  // A rule-3 default chat with staff: extra-bot turns render speaker headers
  // (thinking stays visible, unlike rooms).
  const sharedSpeakers = activeGroup == null && activeBot == null && (sharedStaff?.length ?? 0) > 0;

  // Keep the per-session transcript cache fresh (skipped while a switch is in
  // flight so the previous session's items never land under the new path).
  useEffect(() => {
    if (switchingRef.current || state.streaming) return;
    const path = activePathRef.current;
    if (!path || !state.items.length) return;
    const cache = sessionCacheRef.current;
    cache.delete(path);
    cache.set(path, {
      messages: loadedMessagesRef.current,
      earliestOffset: earliestOffsetRef.current,
      canLoadMore,
    });
    while (cache.size > 6) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }, [state.items, state.streaming, canLoadMore]);

  // Landing: no active session (project context kept). The Hero takes over;
  // nothing is created and nothing is deleted. Defined up here so openSession
  // can land on a newly selected space when its remembered session is gone
  // instead of restoring the previous view.
  const showLanding = useCallback(() => {
    switchingRef.current = false;
    activePathRef.current = null;
    setActiveSessionPath(null);
    setHasSession(false);
    setLiveReady(false);
  }, []);

  // Clear the switch cover shortly after it fades (animation is 120ms; the
  // timeout also covers the reduced-motion path where no animation fires). The
  const openSession = useCallback(
    async (path: string | undefined, cwd: string, displayName?: string, opts?: { quietMissing?: boolean }) => {
      const expectedEpoch = ++epochRef.current;
      const requestId = ++latestRequestRef.current;
      // Opening never changes lifecycle: a settled session renders normally
      // and stays under Settled until explicitly un-settled. Unread clears —
      // you are looking at it now.
      if (path) {
        clearUnread(path);
      }
      // Stash the current view so a failed switch can stay put instead of
      // stranding the user on Home.
      const prevPath = activePathRef.current;
      const prevMessages = loadedMessagesRef.current;
      const prevOffset = earliestOffsetRef.current;
      switchingRef.current = true;
      liveReadyRef.current = false;
      activeSessionIdRef.current = null;
      activePathRef.current = path ?? null;
      // Optimistic: the sidebar row highlights and the active identity flips
      // immediately, before any data loads. The old chat stays visible until
      // the new transcript is ready, then swaps in one frame (tail fetch is
      // ~30ms even for the largest sessions).
      setActiveSessionPath(path ?? null);
      setHeaderName(displayName ?? null);
      // Transcript cache (opencode's SESSION_CACHE pattern): switching back to
      // a recently-viewed session renders from memory, no fetch, no re-read ,
      // and the host re-warms in the background. The cache is populated by the
      // items effect below and evicted LRU (bounded by the 16KB tool-output
      // clamp, so a few sessions stay cheap).
      const memo = path ? sessionCacheRef.current.get(path) : undefined;
      if (memo) {
        // Refresh LRU recency.
        const cache = sessionCacheRef.current;
        cache.delete(path!);
        cache.set(path!, memo);
        loadedMessagesRef.current = memo.messages;
        earliestOffsetRef.current = memo.earliestOffset;
        setCanLoadMore(memo.canLoadMore);
      }
      // Fetch the stored transcript tail FIRST so the UI never renders an
      // empty chat while we switch, `reset` + `rebuild` batch into one render
      // with the messages already populated (no empty-state flicker). The tail
      // read is O(tail), not O(file); older windows load on demand.
      let cached: SessionWindow | undefined;
      if (path && !memo) {
        try {
          cached = await bridge.getSessionMessages(path);
        } catch {
          cached = undefined; // fall through to the live switch
        }
      }
      if (expectedEpoch !== epochRef.current) return;
      hasSessionRef.current = true;
      setHasSession(true);
      setLiveReady(false);
      setStats(null);
      // Keep the previous agentState (model, thinking level) until hydrate
      // replaces it: nulling it here blanks the model/thinking pickers to
      // "select model" / disabled for every switch, which reads as flicker.
      // The new session's values land within ~100ms via hydrate.
      // Models are session-independent (one global registry): keep them across
      // switches so the model picker and thinking options never wait on the
      // host open. Commands are cwd-bound and must reload per project.
      setCommands([]);
      setHistory({ turns: [], leafId: null, hasBranches: false });
      rollbackDraftRef.current = null;
      setRollbackPlan(null);
      dispatch({ type: "reset" });
      if (memo) {
        // Render from memory; the host re-warms below.
        dispatch({ type: "rebuild", messages: memo.messages });
      } else {
        loadedMessagesRef.current = cached?.messages ?? [];
        earliestOffsetRef.current = cached?.startOffset ?? null;
        setCanLoadMore(cached != null && cached.startOffset > 0);
        if (cached?.messages.length) dispatch({ type: "rebuild", messages: cached.messages });
      }
      try {
        await bridge.openSession({ path, cwd, requestId });
      } catch (e: any) {
        if (expectedEpoch !== epochRef.current) return;
        switchingRef.current = false;
        const missingFile =
          path != null && e?.message != null && String(e.message).includes("session path does not exist");
        if (missingFile) {
          // Stale sidebar index or persisted tab: the transcript file is
          // gone. Evict every tab pointing at it, forget it per space,
          // refresh the index, and fall through below — or, for a speculative
          // resume on space entry, land on the newly selected space instead
          // of switching back to the previous view.
          const dead = path;
          setNavTabs((prev) => {
            const tabs = prev.tabs.filter((t) => t.path !== dead);
            const activeBySpace = Object.fromEntries(
              Object.entries(prev.activeBySpace).filter(([, p]) => p !== dead)
            );
            persistTabs({ tabs, activeBySpace });
            return { tabs, activeBySpace };
          });
          void refreshSessions();
          if (opts?.quietMissing) {
            showLanding();
            return;
          }
          // Explicit opens still explain what happened.
          toast("info", "That session file no longer exists — cleaned up its tab.");
        } else {
          toast("error", e?.message ?? "failed to open session");
        }
        if (prevPath) {
          activePathRef.current = prevPath;
          setActiveSessionPath(prevPath);
          loadedMessagesRef.current = prevMessages;
          earliestOffsetRef.current = prevOffset;
          setCanLoadMore(prevOffset != null && prevOffset > 0);
          if (prevMessages.length) dispatch({ type: "rebuild", messages: prevMessages });
        } else {
          setHasSession(false);
          setLiveReady(false);
        }
      }
    },
    [toast, clearUnread, refreshSessions, showLanding]
  );

  // User-curated spaces (herdr): folders you add explicitly. The pi session
  // index is never auto-imported into the sidebar.
  const [spaces, setSpaces] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("babylon:spaces") ?? "[]")
  );
  const addSpace = useCallback(async () => {
    const cwd = await bridge.pickFolder();
    if (!cwd) return;
    setSpaces((prev) => {
      if (prev.includes(cwd)) return prev;
      const next = [...prev, cwd];
      localStorage.setItem("babylon:spaces", JSON.stringify(next));
      return next;
    });
    const latest = groups
      .find((g) => g.cwd === cwd)
      ?.sessions.slice()
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (latest) {
      await openSession(latest.path, cwd);
    } else {
      // No sessions yet: land on the project with no session (home screen)
      // instead of auto-creating one — same as selecting an empty space.
      setActiveSpace(cwd);
      showLanding();
    }
  }, [groups, openSession, setActiveSpace, showLanding]);
  const removeSpace = useCallback((cwd: string) => {
    setSpaces((prev) => {
      const next = prev.filter((c) => c !== cwd);
      localStorage.setItem("babylon:spaces", JSON.stringify(next));
      return next;
    });
  }, []);
  // Explicit tab close: the tab goes away, the session stays on disk and in
  // history. Closing the active tab falls back to its neighbor (then a pinned
  // session, then landing). Idle runtimes are released (listeners/resources
  // freed); live work is never evicted by closing its tab.
  const closeTab = useCallback((path: string) => {
    const { tabs, fallback } = closeNavTab(navTabs.tabs, path);
    persistTabs({ tabs, activeBySpace: navTabs.activeBySpace });
    setNavTabs((prev) => ({ ...prev, tabs }));
    const exec = runtimeByPathRef.current[path]?.execution ?? "idle";
    if (exec === "idle" || exec === "failed") {
      void bridge
        .releaseSession(path)
        .then((r) => {
          // Released runtimes can never emit again: drop the local entry so
          // no late duplicate can resurrect it.
          if (r?.released) {
            setExecutions((prev) => {
              if (!prev[path]) return prev;
              const next = { ...prev };
              delete next[path];
              return next;
            });
          }
        })
        .catch(() => undefined);
    }
    if (path === activePathRef.current) {
      const pinnedHere = pinnedOrder.filter(
        (p) => p !== path && !tabs.some((t) => t.path === p) && groups.some((g) => g.sessions.some((s) => s.path === p))
      );
      const nextTab = fallback ?? (pinnedHere.length ? (() => {
        for (const g of groups) {
          const s = g.sessions.find((x) => x.path === pinnedHere[pinnedHere.length - 1]);
          if (s) return { path: s.path, cwd: s.cwd };
        }
        return null;
      })() : null);
      if (nextTab) void openSession(nextTab.path, nextTab.cwd);
      else showLanding();
    }
  }, [navTabs, pinnedOrder, groups, openSession, showLanding]);
  closeTabRef.current = closeTab;
  // Space selection: adopt the project context, then resume its most recently
  // active open tab — or land on the project with no session (never auto-create).
  // The resume is speculative: a remembered tab whose file was deleted outside
  // the app lands quietly instead of erroring.
  const selectSpace = useCallback((cwd: string) => {
    setActiveSpace(cwd);
    const tab = pickSpaceTab(navTabs.tabs, navTabs.activeBySpace, cwd);
    if (tab) void openSession(tab.path, tab.cwd, undefined, { quietMissing: true });
    else showLanding();
  }, [navTabs, openSession, setActiveSpace, showLanding]);

  // Scroll-up streaming: fetch the next older window of the stored transcript
  // and prepend it. The viewport stays put via ChatView's prepend
  // compensation; the full transcript is always mounted.
  const loadEarlier = useCallback(async () => {
    const path = activePathRef.current;
    const endOffset = earliestOffsetRef.current;
    if (!path || endOffset == null || loadingMoreRef.current) return;
    const epoch = epochRef.current;
    loadingMoreRef.current = true;
    setLoadingEarlier(true);
    try {
      const older = await bridge.getSessionWindow(path, endOffset);
      if (epoch !== epochRef.current || !older.messages.length) return;
      loadedMessagesRef.current = [...older.messages, ...loadedMessagesRef.current];
      earliestOffsetRef.current = older.startOffset;
      setCanLoadMore(older.startOffset > 0);
      dispatch({ type: "rebuild", messages: loadedMessagesRef.current });
    } catch {
      /* file may have moved; the trigger simply stops firing */
    } finally {
      if (epoch === epochRef.current) {
        loadingMoreRef.current = false;
        setLoadingEarlier(false);
      }
    }
  }, []);

  // Every "new session" entry point opens the project picker: choose one
  // of the added projects (most recently used first) and the fresh chat
  // starts there. A folder outside the list goes through the folder picker.
  const [showNewSession, setShowNewSession] = useState(false);
  const newSessionProjects = useMemo(() => {
    const byCwd = new Map(groups.map((g) => [g.cwd, g.sessions]));
    return spaces.map((cwd) => {
      const sessions = byCwd.get(cwd) ?? [];
      let lastUsed = 0;
      for (const s of sessions) if (s.mtime > lastUsed) lastUsed = s.mtime;
      return { cwd, name: cwd.split("/").filter(Boolean).pop() || cwd, lastUsed };
    });
  }, [spaces, groups]);
  const newSession = useCallback(() => {
    setShowNewSession(true);
  }, []);
  const chooseNewSessionProject = useCallback(
    async (cwd: string) => {
      setShowNewSession(false);
      await openSession(undefined, cwd);
    },
    [openSession]
  );

  // Project settings entry: resilient, the header button and the Bots shelf
  // share this so the click is never dead. Uses the loaded snapshot when
  // present, otherwise fetches on demand (a fresh session can render before
  // the background load lands); failures toast instead of silently swallowing.
  const openProject = useCallback(async () => {
    if (projectSettings) {
      setShowProject(true);
      return;
    }
    const cwd = status.cwd;
    if (!cwd) {
      toast("info", "Open a project folder first");
      return;
    }
    try {
      const v = await bridge.projectSettingsGet(cwd);
      setProjectSettings(v);
      setShowProject(true);
    } catch (e: any) {
      toast("error", e?.message ?? "could not load project settings");
    }
  }, [projectSettings, status.cwd, toast]);

  // Switch to a different (or new) project folder.
  const openFolder = useCallback(async () => {
    const cwd = await bridge.pickFolder();
    if (cwd) await openSession(undefined, cwd);
  }, [openSession]);

  // Bot Mode: open a bot's canonical forever-chat. The main process opens the
  // host session (installing the persona overlay + model pin and creating the
  // canonical file on first open); the renderer then displays it through the
  // normal session path, which re-derives the same overlay by file lookup.
  const openBot = useCallback(async (bot: Bot) => {
    setPromotedParent(null);
    try {
      const result = await bridge.botsOpen(bot.id);
      void bridge.botsList().then(setBots).catch(() => undefined);
      let cwd = bot.cwd ?? (projectFilter !== "all" ? projectFilter : status.cwd) ?? status.cwd;
      if (!cwd) {
        const picked = await bridge.pickFolder();
        if (!picked) {
          toast("info", "Pick a project folder to open the bot chat");
          return;
        }
        cwd = picked;
      }
      await openSession(result.sessionFile ?? undefined, cwd, bot.name);
    } catch (e: any) {
      // Drop the optimistic row/header so a failed open can't strand the UI
      // on a session that never displayed (header falls back to live status).
      setActiveSessionPath(null);
      setHeaderName(null);
      toast("error", e?.message ?? "could not open bot chat");
    }
  }, [openSession, projectFilter, status.cwd, toast]);

  const createBot = useCallback(async (input: NewBotInput) => {
    const created = await bridge.botsCreate(input);
    void bridge.botsList().then(setBots).catch(() => undefined);
    toast("info", `Bot "${created.name}" created`);
  }, [toast]);
  // Hire into this project: create the employee globally, staff them here.
  const createAndStaffBot = useCallback(
    async (input: NewBotInput) => {
      const created = await bridge.botsCreate(input);
      await bridge.botsList().then(setBots).catch(() => undefined);
      if (projectSettings) {
        const next = await bridge.projectSettingsMembers(projectSettings.hash, [
          ...projectSettings.settings.memberIds,
          created.id,
        ]);
        setProjectSettings({ hash: projectSettings.hash, settings: next });
      }
      toast("info", `Bot "${created.name}" hired`);
    },
    [projectSettings, toast]
  );

  const updateBot = useCallback(async (id: string, patch: BotPatch) => {
    await bridge.botsUpdate(id, patch);
    void bridge.botsList().then(setBots).catch(() => undefined);
  }, []);

  const deleteBot = useCallback(async (bot: Bot) => {
    if (!(await confirmAction({ title: `Delete bot "${bot.name}"?`, message: "Its chat files stay on disk; routines and mentions stop resolving.", confirmLabel: "Delete bot", danger: true }))) return;
    try {
      await bridge.botsDelete(bot.id);
      void bridge.botsList().then(setBots).catch(() => undefined);
      toast("info", `Bot "${bot.name}" deleted`);
    } catch (e: any) {
      toast("error", e?.message ?? "could not delete bot");
    }
  }, [toast]);

  // Group rooms: open the shared session through the normal display path.
  const openGroup = useCallback(async (group: BotGroup) => {
    setPromotedParent(null);
    try {
      const result = await bridge.groupsOpen(group.id);
      void bridge.groupsList().then(setBotGroups).catch(() => undefined);
      const memberCwd = bots.find((b) => b.id === group.memberIds[0])?.cwd;
      let cwd = group.cwd ?? memberCwd ?? (projectFilter !== "all" ? projectFilter : status.cwd) ?? status.cwd;
      if (!cwd) {
        const picked = await bridge.pickFolder();
        if (!picked) {
          toast("info", "Pick a project folder to open the room");
          return;
        }
        cwd = picked;
      }
      await openSession(result.sessionFile ?? undefined, cwd, group.name);
    } catch (e: any) {
      setActiveSessionPath(null);
      setHeaderName(null);
      toast("error", e?.message ?? "could not open group room");
    }
  }, [openSession, projectFilter, status.cwd, toast, bots]);

  const createGroup = useCallback(async (input: NewGroupInput) => {
    const created = await bridge.groupsCreate(input);
    void bridge.groupsList().then(setBotGroups).catch(() => undefined);
    toast("info", `Group "${created.name}" created`);
  }, [toast]);

  const updateGroup = useCallback(async (id: string, patch: { name?: string; memberIds?: string[] }) => {
    await bridge.groupsUpdate(id, patch);
    void bridge.groupsList().then(setBotGroups).catch(() => undefined);
  }, []);

  const deleteGroup = useCallback(async (group: BotGroup) => {
    if (!(await confirmAction({ title: `Delete group "${group.name}"?`, message: "Its room files stay on disk.", confirmLabel: "Delete group", danger: true }))) return;
    try {
      await bridge.groupsDelete(group.id);
      void bridge.groupsList().then(setBotGroups).catch(() => undefined);
      toast("info", `Group "${group.name}" deleted`);
    } catch (e: any) {
      toast("error", e?.message ?? "could not delete group");
    }
  }, [toast]);

  // Bot-to-bot DM: one attributed turn in the target's chat; the reply lands
  // in the open chat as an activity line (success needs no toast, the relay
  // line is the confirmation). Failures rethrow so the panel keeps the draft
  // open with the error inline.
  // Handoffs: adopted history is read-only; the default agent summarizes a past
  // thread into a sidecar file, consumed later as a compaction boundary.
  const createHandoff = useCallback(
    async (sourcePath: string) => {
      if (!projectSettings) {
        toast("error", "Open the project first, it needs settings to author the handoff");
        return;
      }
      try {
        toast("info", "Summarizing handoff…");
        const handoff = await bridge.handoffCreate(projectSettings.hash, sourcePath);
        toast("info", `Handoff by ${handoff.author} ready, consume it from this chat's menu`);
      } catch (e: any) {
        toast("error", e?.message ?? "could not create handoff");
      }
    },
    [projectSettings, toast]
  );
  const consumeHandoff = useCallback(
    async (sourcePath: string) => {
      const live = activeSessionPath ?? status.sessionPath;
      if (!live) {
        toast("error", "Open the live chat first, handoffs install there");
        return;
      }
      try {
        const list = await bridge.handoffList(sourcePath);
        const latest = list[list.length - 1];
        if (!latest) {
          toast("info", "No handoffs yet, create one first");
          return;
        }
        await bridge.handoffConsume(latest.id, live);
        toast("info", "Handoff installed");
      } catch (e: any) {
        toast("error", e?.message ?? "could not consume handoff");
      }
    },
    [activeSessionPath, status.sessionPath, toast]
  );
  const send = useCallback(
    async (text: string, images?: Attachment[], streamingBehavior?: "steer" | "followUp"): Promise<boolean> => {
      const hasContent = Boolean(text.trim() || images?.length);
      try {
        // Echo the message immediately. Waiting for the session to warm before
        // showing it makes a cold open read as a freeze: nothing appears until
        // the turn finally starts. The optimistic row is rolled back below if
        // the wait or the send fails.
        if (hasContent) {
          dispatch({
            type: "local-user",
            text,
            images: images?.map((image) => `data:${image.mimeType};base64,${image.data}`),
          });
        }
        if (history.activeRollback) {
          setHistory((current) => ({ ...current, activeRollback: undefined }));
        }
        // If the agent is still warming, wait only for the matching open request.
        // A ready/error from an older serialized switch must not release this send.
        if (!liveReadyRef.current) {
          const expectedEpoch = epochRef.current;
          const requestId = latestRequestRef.current;
          setPreparingTurn(true);
          try {
            await new Promise<void>((resolve, reject) => {
              let off: (() => void) | null = null;
              const timeout = setTimeout(() => {
                off?.();
                reject(new Error("session warmup timed out"));
              }, 15000);
              off = bridge.onStatus((s) => {
                if (expectedEpoch !== epochRef.current) {
                  clearTimeout(timeout);
                  off?.();
                  reject(new Error("session changed before the message could be sent"));
                  return;
                }
                if (s.requestId !== undefined && s.requestId !== requestId) return;
                if (s.status === "ready") {
                  clearTimeout(timeout);
                  off?.();
                  resolve();
                } else if (s.status === "exited" || s.status === "error") {
                  clearTimeout(timeout);
                  off?.();
                  reject(new Error(s.message ?? "session failed to open"));
                }
              });
            });
          } finally {
            setPreparingTurn(false);
          }
        }
        if (activeGroup && !streamingBehavior) {
          // Group room: the driver sends the message and runs serial member
          // turns in the same session. Text only, attachments stay in 1:1s.
          if (images?.length) {
            dispatch({ type: "local-user-rollback", text });
            toast("info", "Images stay in 1:1 chats, rooms take text for now");
            return false;
          }
          const room = await bridge.groupSend(activeGroup.id, text);
          appendEvents([
            createBabylonEvent("message.sent", {
              owner: stampOwnership(
                activeSessionIdRef.current ? { sessionId: activeSessionIdRef.current } : {}
              ),
            }),
          ]);
          if (room.stopped) toast("info", "Room rounds stopped");
          if (history.activeRollback) await hydrate();
          return true;
        }
        await bridge.prompt(
          text,
          images?.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType })),
          streamingBehavior
        );
        // Real transition: the host accepted the prompt. Ownership is the live
        // session's runtime id; no message id is fabricated when absent.
        appendEvents([
          createBabylonEvent("message.sent", {
            owner: stampOwnership(
              activeSessionIdRef.current ? { sessionId: activeSessionIdRef.current } : {}
            ),
          }),
        ]);
        if (history.activeRollback) await hydrate();
        return true;
      } catch (e: any) {
        if (hasContent) dispatch({ type: "local-user-rollback", text });
        toast("error", e?.message ?? "send failed");
        if (history.activeRollback) void hydrate();
        return false;
      }
    },
    [history.activeRollback, hydrate, toast, appendEvents, activeGroup]
  );

  const abort = useCallback(async () => {
    try {
      await bridge.abort();
    } catch {
      /* ignore */
    }
  }, []);

  // Stop a live subagent/thread/workflow from its LaunchCard. Routes to the
  // correct bridge control by run kind; the store flips the card to "stopped"
  // when the matching babylon_launch_update/terminated event lands.
  const controlLaunch = useCallback(
    async (runId: string, runKind: "subagent" | "thread" | "workflow", action: "stop") => {
      try {
        if (runKind === "subagent") await bridge.subagentsControl(action, runId);
        else if (runKind === "thread") await bridge.threadsControl(action, runId);
        else if (runKind === "workflow") await bridge.workflowsControl(action, runId);
      } catch (e: any) {
        toast("error", e?.message ?? "failed to control launch");
      }
    },
    [toast]
  );

  const setModel = useCallback(
    async (provider: string, modelId: string) => {
      try {
        const prev = agentState?.model;
        await bridge.setModel(provider, modelId);
        setAgentState(await bridge.getState());
        // In-chat alert when the live session's model actually changes.
        // Skipped with no active session, and when re-selecting the same model.
        if (
          hasSessionRef.current &&
          (prev?.provider !== provider || prev?.id !== modelId)
        ) {
          const name =
            models.find((m) => m.provider === provider && m.id === modelId)?.name ?? modelId;
          dispatch({ type: "notice", text: `Switched to ${provider}/${name}` });
        }
      } catch (e: any) {
        toast("error", e?.message ?? "model switch failed");
      }
    },
    [toast, agentState, models]
  );

  const setThinking = useCallback(
    async (level: string) => {
      try {
        await bridge.setThinking(level);
        setAgentState(await bridge.getState());
      } catch (e: any) {
        toast("error", e?.message ?? "thinking level change failed");
      }
    },
    [toast]
  );

  // Theme is owned by useTheme (Settings → Appearance).

  const compact = useCallback(async () => {
    try {
      await bridge.compact();
    } catch (e: any) {
      toast("error", e?.message ?? "compaction failed");
    }
  }, [toast]);

  const forkCurrent = useCallback(async () => {
    if (!(await confirmAction({ title: "Fork the current session into a separate session?", message: "The current session remains preserved.", confirmLabel: "Fork" }))) return;
    try {
      const result = await bridge.clone();
      if (result.cancelled) return;
      toast("info", "Forked current session");
      await hydrate();
      await refreshSessions();
    } catch (error: any) {
      toast("error", error?.message ?? "failed to fork session");
    }
  }, [hydrate, refreshSessions, toast]);

  const ready = status.status === "ready";
  const activeBranch: string | undefined =
    (agentState?.gitWorktree?.branch as string | undefined) ??
    (agentState?.git?.branch as string | undefined);
  const runningWorkflows = workflowRuns.filter((r) => r.status === "running" || r.status === "paused").length;
  const subagentCount = activity.subagents.length;
  // Active-session busyness (transcript + host truth): drives the composer
  // mode buttons and abort, which are all scoped to the open session —
  // background runs must never flip them. Derived as a boolean so downstream
  // memos depend on the value, not the whole agentState object.
  const agentIsStreaming = agentState?.isStreaming === true;
  const activeStreaming = state.streaming || agentIsStreaming;
  // Canonical session/runtime state (Slice 2): lifecycle × execution ×
  // attention derived ONCE per render from every source, then consumed by the
  // sidebar, Space dots, header, and Agents dock. No consumer reconstructs
  // liveness from its own boolean mix anymore.
  const runtimeByPath = useMemo(
    () =>
      computeRuntimeByPath({
        groups,
        executions,
        settled,
        unread,
        attention,
        activity,
        workflowRuns,
        activeSessionPath,
        statusSessionPath: status.sessionPath,
        statusCwd: status.cwd,
        streaming: state.streaming,
        agentIsStreaming,
        activeSessionId: activeSessionIdRef.current ?? "",
        bots,
      }),
    [groups, executions, settled, unread, attention, activity, workflowRuns, activeSessionPath, status.sessionPath, status.cwd, state.streaming, agentIsStreaming, bots]
  );
  runtimeByPathRef.current = runtimeByPath;
  groupsRef.current = groups;
  // Per-session liveness is dead: runtimeByPath (above) owns it now.
  const contextOpen = showWorkflowsPanel || showBranchPanel || showSimPanel;
  const headerGit = status.cwd ? gitStatuses[status.cwd] ?? null : null;
  const activeDirtyCount = (headerGit as any)?.isRepo ? ((headerGit as any).dirty?.length ?? 0) : 0;

  // ---- Spaces / Agents / Tabs nav model ----
  const sessionByPath = useMemo(() => buildSessionByPath(groups), [groups]);
  // Space-scoped surfaces (Activity agents) attribute a session file to its project.
  const resolveSessionCwd = useCallback(
    (file: string | null | undefined) => (file ? (sessionByPath.get(file)?.cwd ?? null) : null),
    [sessionByPath]
  );
  // Workflow runs carry only a sessionId; map it through the session index.
  const resolveRunCwd = useCallback(
    (sessionId: string | null | undefined) => {
      if (!sessionId) return null;
      const file = sessionIdToPathRef.current.get(sessionId);
      return file ? (sessionByPath.get(file)?.cwd ?? null) : null;
    },
    [sessionByPath]
  );
  // Activity badge: running subagents/threads/workflows in the current space,
  // derived from the SAME selector the Activity panel lists, so the count and
  // the list can never disagree.
  const activityBadge = useMemo(
    () =>
      countRunningWork({
        threads: activity.threads,
        subagents: activity.subagents,
        workflows: workflowRuns,
        scope: activeSpace ?? status.cwd ?? null,
        resolveCwd: resolveSessionCwd,
        resolveRunCwd,
      }),
    [activity, workflowRuns, activeSpace, status.cwd, resolveSessionCwd, resolveRunCwd]
  );
  const sessionTitle = useCallback(
    (path: string) => resolveSessionTitle(sessionByPath, path),
    [sessionByPath]
  );
  const tabItems = useMemo(
    () => buildTabItems(navTabs.tabs, sessionByPath, sessionTitle),
    [navTabs.tabs, sessionByPath, sessionTitle]
  );
  // Tabs are per project: the header only shows the active space's working
  // set. Other projects keep their tabs, restored on space switch.
  const visibleTabItems = useMemo(() => {
    const cwd = activeSpace ?? status.cwd;
    return visibleSpaceTabs(tabItems, cwd ?? null);
  }, [tabItems, activeSpace, status.cwd]);
  const attentionByPath = useMemo(() => buildAttentionByPath(runtimeByPath), [runtimeByPath]);
  const historyEntries = useMemo(
    () => buildHistoryEntries(groups, new Set(navTabs.tabs.map((t) => t.path))),
    [groups, navTabs.tabs]
  );
  const mtimeByPath = useMemo(() => buildMtimeByPath(groups), [groups]);
  const liveAgentRows = useMemo(
    () => buildLiveAgentRows(Object.values(runtimeByPath), mtimeByPath, sessionTitle),
    [runtimeByPath, mtimeByPath, sessionTitle]
  );
  const allSpaceCwds = useMemo(() => buildAllSpaceCwds(spaces, activeSpace), [spaces, activeSpace]);

  // Diagnostics snapshot, recomputed only when an input to it actually
  // changes, not on every unrelated render while the panel is open. The
  // background policy input is a constant in this build, so it varies never.
  const diagnosticsSnapshot = useMemo(
    () =>
      collectDiagnostics({
        now: Date.now(),
        attention,
        policy: defaultPolicy(),
        events: eventLog,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showDiagnostics, attention, eventLog]
  );

  // Stable handlers for the memoized Sidebar/ChatView. Their identity must not
  // change per render (streaming ticks, keystrokes), or the memo boundary is
  // defeated and the whole subtree re-renders.
  const onOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const onToggleMinimize = useCallback(() => {
    setSidebarMinimized((minimized) => {
      setWithFallback("sidebar-minimized", minimized ? "0" : "1");
      return !minimized;
    });
  }, []);
  const onOpenSidebarSession = useCallback(
    (path: string | undefined, cwd: string, name?: string) => {
      setPromotedParent(null);
      void openSession(path, cwd, name);
    },
    [openSession]
  );
  const onDeleteSession = useCallback(
    async (path: string, name: string) => {
      if (!(await confirmAction({ title: `Delete chat "${name}"?`, message: "This cannot be undone.", confirmLabel: "Delete chat", danger: true }))) return;
      try {
        await bridge.deleteSession(path);
        toast("info", "Chat deleted");
      } catch (error: any) {
        toast("error", error?.message ?? "could not delete chat");
      }
    },
    [toast]
  );
  const onOpenTree = useCallback(() => {
    if (!ready || !hasSession) return;
    setShowBranchPanel((open) => !open);
    setShowWorkflowsPanel(false);
  }, [ready, hasSession]);
  const onSearch = useCallback(() => togglePalette(true), [togglePalette]);
  const onAddSpace = useCallback(() => void addSpace(), [addSpace]);
  const onOpenLiveAgent = useCallback(
    (row: (typeof liveAgentRows)[number]) => {
      setPromotedParent(null);
      void openSession(row.agent.path, row.agent.cwd);
    },
    [openSession]
  );

  // Stable ChatView props (its `items` change per token, but unrelated App
  // renders must not re-render the transcript subtree).
  const chatOnNeedEarlier = useCallback(() => void loadEarlier(), [loadEarlier]);
  const chatOnRollback = useCallback((entryId: string) => void prepareRollback(entryId), [prepareRollback]);
  const chatOnOpenLaunch = useCallback(() => setShowWorkflowsPanel(true), []);
  const chatOnControlLaunch = useCallback(
    (runId: string, runKind: "subagent" | "thread" | "workflow", action: "stop") =>
      void controlLaunch(runId, runKind, action),
    [controlLaunch]
  );
  const chatRoomMembers = useMemo(
    () =>
      activeGroup
        ? bots.filter((b) => activeGroup.memberIds.includes(b.id))
        : sharedSpeakers
          ? (sharedStaff ?? [])
          : [],
    [activeGroup, bots, sharedSpeakers, sharedStaff]
  );
  const chatProjectName = useMemo(() => {
    const cwd = activeSpace ?? status.cwd;
    return cwd ? cwd.split("/").filter(Boolean).pop() || cwd : null;
  }, [activeSpace, status.cwd]);

  const goalPath = activeSessionPath ?? status.sessionPath ?? null;
  const goalForPath = goalPath ? goals[goalPath] ?? null : null;
  const goalActive = !!goalForPath && !goalForPath.done;
  const compactionCount = useMemo(() => countCompactions(state.items), [state.items]);

  // Preload/bridge missing (e.g. renderer opened outside Electron, or the
  // preload script failed to load). Previously `window.pideck` was accessed
  // unconditionally, every effect threw, React unmounted the tree, and the
  // window went blank, no UI, no error. Render a visible screen instead.
  if (!bridgeAvailable) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="w-full max-w-md text-center">
          <h1 className="mt-4 text-[20px] font-semibold">Babylon</h1>
          <p className="mt-1 text-[13px] text-dim">Renderer bridge unavailable</p>
          <p className="mt-4 rounded-xl border border-warn/40 bg-warn/10 p-4 text-[13px] leading-relaxed text-fg/80">
            Babylon couldn't reach the Electron main process. The preload script may have failed to
            load, or the renderer was opened outside the app. Close this window and relaunch Babylon.
          </p>
          <button
            onClick={() => location.reload()}
            className="mt-5 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-bg hover:opacity-90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell flex h-full">
    {settingsOpen ? (
      <Suspense fallback={null}>
      <SettingsPage
        models={models}
        agentState={agentState}
        theme={themePref}
        themeId={themeId}
        onThemeIdChange={setThemeId}
        onThemeChange={setThemePref}
        onClose={() => setSettingsOpen(false)}
        botsManager={{
          bots,
          activeBotId: activeBot?.id ?? null,
          groups: botGroups,
          activeGroupId: activeGroup?.id ?? null,
          defaultBot: appDefaultBot,
          onSaveDefaultBot: async (input) => {
            setAppDefaultBot(await bridge.botsDefaultSet(input));
          },
          onCreate: createBot,
          onUpdate: updateBot,
          onDelete: deleteBot,
          onCreateGroup: createGroup,
          onUpdateGroup: updateGroup,
          onDeleteGroup: deleteGroup,
          onOpenGroup: async (group) => {
            setSettingsOpen(false);
            await openGroup(group);
          },
        }}
      />
      </Suspense>
    ) : null}
      {goalOpen && hasSession && goalPath ? (
        <GoalOverlay
          key={goalPath}
          goal={goalForPath}
          onStart={(objective) => updateGoals((m) => startGoal(m, goalPath, objective))}
          onFinish={() => updateGoals((m) => finishGoal(m, goalPath))}
          onClear={() => updateGoals((m) => clearGoal(m, goalPath))}
          onClose={() => setGoalOpen(false)}
          onMove={(pos) => updateGoals((m) => moveGoal(m, goalPath, pos))}
        />
      ) : null}
      {statsCardOpen && hasSession ? (
        <StatsCard
          tokens={stats?.tokens ?? null}
          totalMessages={stats?.totalMessages}
          compactionCount={compactionCount}
          samples={turnSamples.path === goalPath ? turnSamples.samples : []}
          streaming={activeStreaming}
          initialPos={statsCardPos}
          onMove={(pos) => writeStringPref("statsCardPos", `${Math.round(pos.x)},${Math.round(pos.y)}`)}
          onClose={() => writeBoolPref("statsCard", false)}
        />
      ) : null}
      {showProject && projectSettings && status.cwd ? (
        <Suspense fallback={null}>
        <ProjectPanel
          projectPath={status.cwd}
          settings={projectSettings.settings}
          hash={projectSettings.hash}
          employees={bots}
          onSaveDefault={(patch) => bridge.projectDefaultUpdate(projectSettings.hash, patch)}
          onResetDefault={() => bridge.projectDefaultReset(projectSettings.hash)}
          onSetMembers={(ids) => bridge.projectSettingsMembers(projectSettings.hash, ids)}
          onSetFreeSpeak={(on) => bridge.projectSettingsFreespeak(projectSettings.hash, on)}
          onCreateAndStaff={createAndStaffBot}
          onChanged={(next) => setProjectSettings({ hash: projectSettings.hash, settings: next })}
          onClose={() => setShowProject(false)}
        />
        </Suspense>
      ) : null}
      <Sidebar
        groups={groups}
        activePath={activeSessionPath ?? status.sessionPath}
        activeCwd={activeSpace ?? status.cwd}
        treeOpen={showBranchPanel}
        canOpenTree={ready && hasSession}
        minimized={sidebarMinimized}
        onOpenSettings={onOpenSettings}
        onToggleMinimize={onToggleMinimize}
        onPrefetch={prefetchSession}
        onOpen={onOpenSidebarSession}
        onNew={newSession}
        onSelectSpace={selectSpace}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
        onDeleteSession={onDeleteSession}
        onOpenFolder={openFolder}
        onOpenTree={onOpenTree}
        onSearch={onSearch}
        pinnedOrder={pinnedOrder}
        snoozed={snoozed}
        archived={archived}
        unread={unread}
        showArchived={showArchived}
        runtime={runtimeByPath}
        settled={settled}
        onSettle={settleSession}
        onUnsettle={unsettleSession}
        activeBranch={activeBranch}
        gitStatuses={gitStatuses}
        onRefreshGitStatus={refreshGitStatusForCwd}
        spaceCwds={spaces}
        onAddSpace={onAddSpace}
        onRemoveSpace={removeSpace}
        liveAgents={liveAgentRows}
        allSpaceCwds={allSpaceCwds}
        onOpenLiveAgent={onOpenLiveAgent}
        onTogglePin={togglePin}
        onToggleSnooze={toggleSnooze}
        onToggleUnread={toggleUnread}
        onToggleArchive={toggleArchive}
        onRename={renameSession}
        onCopy={copySession}
        onCreateHandoff={createHandoff}
        onConsumeHandoff={consumeHandoff}
        onToggleShowArchived={toggleShowArchived}
      />

      <div className="flex min-w-0 flex-1">
        <main className="primary-workspace relative flex min-w-0 flex-1 flex-col min-h-0">
          <header className={`thread-header titlebar shrink-0 z-10 flex h-11 items-center gap-2 border-b border-line bg-bg ${sidebarMinimized ? "pl-[88px] pr-3" : "pl-0 pr-3"}`}>
            {sidebarMinimized ? (
              <button
                onClick={() => {
                  setWithFallback("sidebar-minimized", "0");
                  setSidebarMinimized(false);
                }}
                title="Show sidebar (⌘B)"
                aria-label="Show sidebar"
                className="sidebar-expand shrink-0"
              >
                <ChevronIcon size={13} className="text-dim" />
              </button>
            ) : null}
            {promotedParent ? <button onClick={() => { const parent = promotedParent; setPromotedParent(null); void openSession(parent.path, parent.cwd); }} title="Back to parent session" className="thread-action thread-action-text">← Parent</button> : null}
            <SessionTabs
              tabs={visibleTabItems}
              activePath={activeSessionPath ?? status.sessionPath ?? null}
              allCwds={allSpaceCwds}
              attentionByPath={attentionByPath}
              onActivate={(tab) => {
                setPromotedParent(null);
                void openSession(tab.path, tab.cwd);
              }}
              onClose={(path) => closeTab(path)}
              onNew={() => newSession()}
              historyMenu={
                <SessionHistoryMenu
                  entries={historyEntries}
                  onOpen={(entry) => {
                    setPromotedParent(null);
                    void openSession(entry.path, entry.cwd);
                  }}
                />
              }
            />
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {hasSession ? (
                <button
                  onClick={() => {
                    setShowWorkflowsPanel((open) => !open);
                    setShowBranchPanel(false);
                  }}
                  title="Activity, workflows, threads, subagents"
                  aria-pressed={showWorkflowsPanel}
                  className={`thread-action relative ${showWorkflowsPanel ? "is-active" : ""}`}
                >
                  <LayersIcon size={14} />
                  {activityBadge > 0 ? <span className="absolute -right-1 -top-1 min-w-[16px] h-[16px] px-1 grid place-items-center rounded-full bg-accent text-white text-[10px] font-bold leading-none">{activityBadge}</span> : null}
                </button>
              ) : null}
              <button
                onClick={() => { const next = !showSimPanel; setShowSimPanel(next); if (next) { setShowBranchPanel(false); setShowWorkflowsPanel(false); } }}
                title="Browser: preview pages and dev servers in an embedded tabbed browser"
                aria-pressed={showSimPanel}
                className={`thread-action ${showSimPanel ? "is-active" : ""}`}
              >
                <GlobeIcon size={14} />
              </button>
              <button
                onClick={() => setShowCommitPopover(true)}
                title="Commit and push, stages all changes, generates a message, and pushes"
                className="thread-action thread-action-text text-[12px]"
              >
                Commit{activeDirtyCount > 0 ? ` ${activeDirtyCount}` : ""}
              </button>
              {hasSession ? (
                <button
                  onClick={() => setGoalOpen(true)}
                  title="Goal mode: track elapsed time and turns toward an objective"
                  aria-pressed={goalOpen}
                  className={`thread-action thread-action-text text-[12px] ${goalActive ? "text-accent" : ""}`}
                >
                  Goal{goalActive ? " ●" : ""}
                </button>
              ) : null}
              {hasSession ? (
                <button
                  onClick={() => writeBoolPref("statsCard", !statsCardOpen)}
                  title="Session stats: tokens, compactions, TPS, cache hit rate, messages"
                  aria-pressed={statsCardOpen}
                  className={`thread-action ${statsCardOpen ? "is-active" : ""}`}
                >
                  <GaugeIcon size={14} />
                </button>
              ) : null}
              <PanelsMenu
                open={panelsMenuOpen}
                onOpenChange={setPanelsMenuOpen}
                items={[
                  { label: "Runtime diagnostics", open: showDiagnostics, onToggle: () => setShowDiagnostics((v) => !v) },
                ]}
              />
            </div>
            {preparingVisible ? <span className="shrink-0 text-[13px] text-dim">Preparing…</span> : null}
          </header>

          <div className="flex flex-1 min-h-0 flex-col">
              {hasSession ? (
                <ChatView
                  items={state.items}
                  canLoadMore={canLoadMore}
                  loadingEarlier={loadingEarlier}
                  onNeedEarlier={chatOnNeedEarlier}
                  streaming={activeStreaming}
                  isRoom={activeGroup != null}
                  roomHandle={
                    activeGroup != null || sharedSpeakers
                      ? state.roomTurn?.phase === "started"
                        ? state.roomTurn.handle
                        : null
                      : null
                  }
                  roomMembers={chatRoomMembers}
                  roomName={activeGroup?.name ?? ""}
                  showSpeakers={sharedSpeakers}
                  projectName={chatProjectName}
                  streamResponses={streamResponses}
                  historyTurns={history.turns}
                  onRollback={chatOnRollback}
                  onOpenLaunch={chatOnOpenLaunch}
                  onControlLaunch={chatOnControlLaunch}
                />
              ) : (
                <div className="flex flex-1 min-h-0 overflow-hidden">
                  <Hero status={status} groups={groups} onOpen={(path, cwd) => { setPromotedParent(null); void openSession(path, cwd); }} onNew={newSession} spaceCwd={activeSpace ?? status.cwd ?? null} />
                </div>
              )}

            {hasSession && preparingTurn ? (
              <div className="flex items-center gap-2 px-4 pb-2 text-[13px] text-dim" role="status">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
                Preparing session…
              </div>
            ) : null}

            {hasSession ? (
              <SessionFooter
                agentState={agentState}
                stats={stats}
                models={models}
                thinkingLevels={thinkingLevels}
                onSetModel={setModel}
                onSetThinking={setThinking}
                onCompact={compact}
                streaming={activeStreaming}
                steering={state.steering}
                followUp={state.followUp}
                commands={commands}
                draftRequest={draftRequest}
                toast={toast}
                onSend={send}
                onAbort={abort}
                dialogs={state.dialogs}
                onDialogDismiss={(id) => dispatch({ type: "dialog-dismiss", id })}
                runningWorkflows={runningWorkflows}
                subagentCount={subagentCount}
                mentionBots={
                  activeGroup
                    ? bots.filter((b) => activeGroup.memberIds.includes(b.id))
                    : (sharedStaff ?? bots.filter((b) => !b.hidden))
                }
              />
            ) : null}
          </div>
        </main>

        <Suspense fallback={null}>
          {/* The browser backend lives in the main process, not the daemon socket,
              so it renders on toggle alone. Branch/Activity still need the daemon. */}
          {(showSimPanel || (ready && contextOpen)) ? (
            <WorkspacePane width={contextWidth} onResizeStart={beginContextResize}>
              {showSimPanel ? (
                <SimSidebar onClose={() => setShowSimPanel(false)} />
              ) : showBranchPanel ? (
                <BranchPanel
                  onClose={() => setShowBranchPanel(false)}
                  refreshToken={historyRevision}
                  onRollback={(entryId) => void prepareRollback(entryId)}
                  onUndoRollback={() => void undoRollback()}
                  onForkCurrent={() => void forkCurrent()}
                  toast={toast}
                />
              ) : (
                <WorkflowsPanel
                  cwd={activeSpace ?? status.cwd ?? null}
                  resolveCwd={resolveSessionCwd}
                  resolveRunCwd={resolveRunCwd}
                  onOpenSession={(path, targetCwd, parentPath) => {
                    const cwd = targetCwd ?? status.cwd;
                    if (cwd) {
                      if (parentPath && status.cwd) setPromotedParent({ path: parentPath, cwd: status.cwd });
                      void openSession(path, cwd);
                    }
                    setShowWorkflowsPanel(false);
                  }}
                  onClose={() => setShowWorkflowsPanel(false)}
                  toast={toast}
                />
              )}
            </WorkspacePane>
          ) : null}
        </Suspense>
      </div>

      <Suspense fallback={null}>
        {showCommandPalette && (
          <CommandPalette
            groups={groups}
            commands={commands}
            onClose={() => togglePalette(false)}
            onNew={() => {
              togglePalette(false);
              newSession();
            }}
            onOpen={(path, cwd) => {
              setPromotedParent(null);
              void openSession(path, cwd);
            }}
            onCommand={(command) =>
              setDraftRequest({ id: Date.now(), text: insertCommand(command) })
            }
          />
        )}
      </Suspense>
      {showNewSession && (
        <NewSessionModal
          projects={newSessionProjects}
          defaultCwd={activeSpace ?? status.cwd ?? null}
          onChoose={(cwd) => void chooseNewSessionProject(cwd)}
          onPickFolder={() => {
            setShowNewSession(false);
            void openFolder();
          }}
          onClose={() => setShowNewSession(false)}
        />
      )}
      <Suspense fallback={null}>
        {showDiagnostics ? (
          <DiagnosticsPanel
            snapshot={diagnosticsSnapshot}
            onClose={() => setShowDiagnostics(false)}
          />
        ) : null}
      </Suspense>
      <ApprovalGate />
      {rollbackPlan ? (
        <RollbackConfirm
          plan={rollbackPlan}
          busy={rollbackBusy}
          onCancel={() => !rollbackBusy && setRollbackPlan(null)}
          onConfirm={() => void commitRollback()}
        />
      ) : null}

      {showCommitPopover && (
        <GitCommitPopover cwd={status.cwd} onClose={() => setShowCommitPopover(false)} toast={toast} onChanged={refreshGitStatuses} />
      )}
      <DialogHost
        dialogs={state.dialogs}
        onDismiss={(id) => dispatch({ type: "dialog-dismiss", id })}
        toast={toast}
      />
      <PromptHost />
      <Toasts toasts={state.toasts} onDismiss={(id) => dispatch({ type: "toast-dismiss", id })} />
    </div>
  );
}


