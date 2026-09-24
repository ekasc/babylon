import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from "react";
import { bridge, bridgeAvailable, type ActivityUpdate, type AgentModel, type AgentState, type CommandInfo, type HistoryProjection, type ProjectGroup, type ProjectSettings, type SessionMeta, type RuntimeStatus, type SessionStats, type SessionWindow, type SimTabState, type WorkflowRunSummary } from "./bridge";
import type { Bot, BotGroup, BotPatch, DefaultBot, NewBotInput, NewGroupInput } from "./bots";
import { isBotMainSession, isGroupRoom } from "./bots";
import { initialState, mergeLiveMessages, reducer, wireOf, wireStr } from "./store";
import { groupChatCwd, projectFocusTarget, projectSettingsCwd, reconnectExecutions } from "./lib/app-orchestration";
import { planApprovalRequest, planRuntimeEvents } from "./lib/runtime-events";
import { useRuntimeHealth } from "./lib/runtime-health";
import {
  applyRuntimeEvent,
  canSettle,
  computeRuntimeByPath,
  resolveApprovalExecution,
  resolveRuntimePath as resolveRuntimePathPure,
  type PathExecutionMap,
  type SessionRuntimeState,
  type WorkSourceItem,
  emptyExecutions,
} from "./sessionRuntime";
import {
  buildAllSpaceCwds,
  buildAttentionByPath,
  buildHistoryEntries,
  buildSessionByPath,
  buildTabItems,
  resolveSessionTitle,
} from "./app-selectors";
import { insertCommand } from "./commands";
import { countRunningWork } from "./lib/activity";
import { errorMessage, isSessionNotFound } from "./lib/errors";
import {
  indexExecutions,
  mergeExecution,
  showViewLanding,
  viewSession as viewSessionImpl,
  type ViewNavigationDeps,
} from "./lib/view-navigation";
import type { ProjectExecution } from "./execution";
import { clampHard, clampWithRubberband } from "./lib/gesture-math";
import { performSend, type SendExecutionDeps, type SendStage } from "./lib/send-execution";
import { captureTargetThen } from "./lib/confirm-target";
import { performCloseTab } from "./lib/close-tab";
import { deriveExecutionTrees, openExecutionRoot, type ExecutionTree } from "./lib/execution-tree";
import {
  deriveComposerExecutionAccess,
  deriveViewedStreaming,
  executionBusyLabel,
  returnToExecution as returnToExecutionImpl,
  type ComposerExecutionAccessUi,
} from "./lib/composer-execution";
import Sidebar from "./components/Sidebar";
import { useTheme } from "./components/hooks/useTheme";
import { useRollback } from "./components/hooks/useRollback";
import { useGitStatus } from "./components/hooks/useGitStatus";
import { useSidebarState } from "./components/hooks/useSidebarState";
import { useDurableGoal } from "./components/hooks/useDurableGoal";
import { useDesignMode } from "./components/hooks/useDesignMode";
import { usePanels } from "./components/hooks/usePanels";
import { getNumberWithFallback, getWithFallback, setWithFallback } from "./lib/storage";
import { useBoolPref, useStringPref, writeBoolPref, writeStringPref } from "./lib/prefs";
import ChatView from "./components/ChatView";
import { type Attachment } from "./components/Composer";
import DialogHost from "./components/DialogHost";
import Toasts from "./components/Toasts";
import Hero from "./components/Hero";
import { RollbackConfirm } from "./components/Rollback";
import NewSessionModal from "./components/NewSessionModal";
import SessionFooter from "./components/SessionFooter";
import ErrorBoundary, { PaneCrashFallback } from "./components/ErrorBoundary";
import { ApprovalGate } from "./components/ApprovalGate";
import GitCommitPopover from "./components/GitCommitPopover";
// Overlay panels are rarely needed at boot; lazy-load them so they stay out
// of the startup bundle.
const SimSidebar = lazy(() => import("./components/SimSidebar").then((m) => ({ default: m.SimSidebar })));
const CanvasPanel = lazy(() => import("./components/CanvasPanel"));
import { PromptHost, confirmAction, promptText } from "./lib/prompts";
import { createAttentionRegistry } from "./attention";
import { stampOwnership } from "./ownership";
import { addAttention, listAttention, removeAttention, type AttentionRegistry } from "./attention";
import { ChevronIcon, GlobeIcon, LayersIcon, ListIcon, BranchIcon, ClockIcon, FolderIcon, TemplateIcon, ArrowUpIcon } from "./components/icons";
import { SessionTabs } from "./components/SessionTabs";
import { SessionHistoryMenu } from "./components/SessionHistoryMenu";
import { CanvasProvider } from "./components/canvas-context";
import SessionSidebar, { type SessionMenuItem } from "./components/SessionSidebar";
import {
  type DurableGoalState,
} from "./lib/durable-goal";
import {
  activeSpaceStore,
  addNavTab,
  pickSpaceTab,
  spacesStore,
  tabsStore,
  visibleSpaceTabs,
} from "./lib/nav-model";
import { useVersionedState } from "./lib/versioned-store";

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
  const [projectFilter, setProjectFilter] = useState("all");
  // Global session working set (browser model): open tabs in insertion
  // order, independent of Space. Versioned blob (v2; legacy per-space
  // records migrate); persistence is owned by the hook. Closing never deletes.
  const [navTabs, setNavTabs] = useVersionedState(tabsStore);
  // Explicit project context. Follows opened sessions; space selection sets
  // it directly (a space can be active with no session open — landing).
  const [activeSpace, setActiveSpace] = useVersionedState(activeSpaceStore);
  // Pre-warm a project the moment it becomes the active space: the rollback
  // shadow index and the project's model runtime are built while the user is
  // reading, so the first activation (and the first send in it) is not cold.
  useEffect(() => {
    if (activeSpace) void bridge.warmProject(activeSpace).catch(() => undefined);
  }, [activeSpace]);
  // The UI's active Space IS the desktop's project focus (LSP + activity
  // display). Explicit, one-way, and null CLEARS it: nothing about execution
  // ownership travels this way (C2/C6).
  useEffect(() => {
    void bridge.projectFocus(projectFocusTarget(activeSpace));
  }, [activeSpace]);
  // Single choke point for a successfully opened session: register the tab
  // (no reorder), remember it per space, adopt its project context.
  const registerViewedSession = useCallback((cwd: string, path: string) => {
    setNavTabs((prev) => {
      const tabs = addNavTab(prev.tabs, cwd, path);
      return { tabs, activeBySpace: { ...prev.activeBySpace, [cwd]: path } };
    });
    setActiveSpace(cwd);
  }, [setActiveSpace]);

  const [models, setModels] = useState<AgentModel[]>([]);
  // Invariant-read caches for hydrate (every tab switch re-hydrates).
  // Lifecycle rule: caches must not outlive the runtimes they describe.
  // Project models survive execution runtime changes (the ModelRuntime is
  // cwd-owned); thinking levels are model-defined; commands stay uncached
  // because extension registrations belong to the owning execution runtime.
  // Settings saves clear the models map (context-window overrides remap it).
  const modelsCacheRef = useRef(new Map<string, AgentModel[]>());
  const levelsCacheRef = useRef(new Map<string, string[]>());
  // Project of the conversation on screen — the cwd Send captures. It is view
  // state, not a runtime pointer.
  const viewedCwdRef = useRef<string | null>(null);

  const { themePref, themeId, setThemePref, setThemeId } = useTheme();
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const { gitStatuses, refreshGitStatuses, refreshGitStatusForCwd } = useGitStatus(groups);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const {
    showCommitPopover,
    setShowCommitPopover,
    showCommandPalette,
    setShowCommandPalette,
    settingsOpen,
    setSettingsOpen,
    showNewSession,
    setShowNewSession,
    showProject,
    setShowProject,
    sidebarMinimized,
    setSidebarMinimized,
    sideOpen,
    setSideOpen,
  } = usePanels();
  const [attention, setAttention] = useState<AttentionRegistry>(() =>
    createAttentionRegistry(),
  );
  // Non-streaming is the default: hold incremental text until the reply is
  // complete. (Reasoning always renders as one collapsed line.)
  const streamResponses = useBoolPref("streamResponses", false);
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


  // The session sidebar is closed by default and opened on demand, like the app's
  // other right-hand panel. Its X puts it away; the thread header opens it again.

  const [draftRequest, setDraftRequest] = useState<{ id: number; text: string; append?: boolean } | null>(null);
  const [promotedParent, setPromotedParent] = useState<{ path: string; cwd: string } | null>(null);
  // Optimistic active session: set synchronously on click so the sidebar row
  // highlights instantly; the host's status confirm later keeps it exact.
  const [viewedSessionPath, setViewedSessionPath] = useState<string | null>(null);

  // True while a sent message waits for this project's execution activation
  // (the message is on screen; the turn has not started).
  const [preparingTurn, setPreparingTurn] = useState(false);
  // Whether a stored-transcript window older than the current one exists.
  const [canLoadMore, setCanLoadMore] = useState(false);
  // Bumped on every send so the transcript pins to the new message.
  const [pinNonce, setPinNonce] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [activity, setActivity] = useState<ActivityUpdate>({ threads: [], subagents: [] });
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSummary[]>([]);
  // `hasSession` = a conversation's content is on screen (history or live).
  // Runtime existence is NOT a second view flag: it is project execution
  // ownership (executionsByCwd), so there is nothing to "wait for ready" on.
  const [hasSession, setHasSession] = useState(false);
  // The epoch of the session currently on screen. Agent events are tagged with
  // the epoch captured when they start; events from a stale (previous) session
  // are dropped so streams can't bleed into a freshly-opened transcript.
  const epochRef = useRef(0);
  const viewSwitchingRef = useRef(false);
  // Ownership generation for the switching flag: overlapping async
  // operations (tab switch vs stale disk refresh) each claim a token, and
  // only the latest token holder may clear the flag. A boolean alone lets
  // a stale refresh clear a newer tab switch's in-flight state.
  const viewSwitchGenerationRef = useRef(0);
  const claimViewSwitch = useCallback(() => {
    viewSwitchingRef.current = true;
    return ++viewSwitchGenerationRef.current;
  }, []);
  const releaseViewSwitch = useCallback((token: number) => {
    if (token === viewSwitchGenerationRef.current) viewSwitchingRef.current = false;
  }, []);
  const viewedPathRef = useRef<string | null>(null);
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
  const loadedMessagesRef = useRef<unknown[]>([]);
  const earliestOffsetRef = useRef<number | null>(null);
  const loadingMoreRef = useRef(false);
  // Per-session transcript cache (bounded LRU, opencode's SESSION_CACHE
  // pattern): switching back renders from memory instead of re-reading the
  // file, and the host re-warms in the background.
  const sessionCacheRef = useRef(new Map<string, { messages: unknown[]; earliestOffset: number | null; canLoadMore: boolean }>());
  const prefetchingRef = useRef(new Set<string>());
  const streamingRef = useRef(false);
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;
  const hasSessionRef = useRef(false);
  const rollbackDraftRef = useRef<string | null>(null);
  useEffect(() => { hasSessionRef.current = hasSession; }, [hasSession]);
  useEffect(() => { streamingRef.current = state.streaming; }, [state.streaming]);

  const toast = useCallback(
    (type: "info" | "warning" | "error", text: string) =>
      dispatch({ type: "toast", toast: { type, text } }),
    []
  );
  // Durable per-session goal (hardbaked goal-mode extension state): the
  // single source of truth the agent itself enforces.
  const { durableGoal, setDurableGoal, goalTargetRef, refreshDurableGoal, goalControl } = useDurableGoal(toast);
  // Goal arming is renderer-only: clicking Goal arms the next send, which
  // persists the message as the objective and starts the turn itself (no
  // synthetic kickoff turn). Disarmed on send-consume, toggle, navigation.
  const [goalArmed, setGoalArmed] = useState(false);
  // Optimistic pursuit: set when an armed send starts its combined op,
  // cleared when it settles. The backend confirms via setDurableGoal; until
  // then the sent text itself is the displayed objective.
  const [goalPendingObjective, setGoalPendingObjective] = useState<string | null>(null);
  // Design arming mirrors Goal (declared here so toggleGoal below can read
  // it): clicking Design arms the next send, which persists the submitted
  // message as the subject and starts the interview turn itself.
  const [designArmed, setDesignArmed] = useState(false);
  const [designPendingSubject, setDesignPendingSubject] = useState<string | null>(null);
  /** Composer intent (Goal/Design arming) is view-bound: a new view or
   *  landing clears it. Backend state is untouched — it settles on its own. */
  const clearComposerArmings = useCallback(() => {
    setGoalArmed(false);
    setGoalPendingObjective(null);
    setDesignArmed(false);
    setDesignPendingSubject(null);
  }, []);

  // Design mode (hardbaked design-mode extension state): the toggleable
  // phased design flow for this session, same strip pattern as the goal.
  const { designStatus, setDesignStatus, designTargetRef, refreshDesign, designControl } = useDesignMode(toast);
  // (Design arming lives with the goal arming above, so toggleGoal can
  // read it for mutual exclusion.)
  const toggleDesign = useCallback(() => {
    // Mutual exclusion: Goal armed or active blocks Design entirely (the
    // button is disabled too; this guards programmatic callers).
    if (goalArmed || goalPendingObjective != null || durableGoal?.active) {
      toast("info", "Stop the active Goal first");
      return;
    }
    // Active design is a stage indicator, not a toggle: use the menu
    // (End/Restart) to finish it. Arming only toggles when idle/done.
    const stage = designStatus?.stage;
    if (designStatus?.design != null && stage !== "done") return;
    setDesignArmed((armed) => !armed);
  }, [designStatus, goalArmed, goalPendingObjective, durableGoal, toast]);
  const endDesign = useCallback(async () => {
    const target = viewedPathRef.current;
    if (!target) return;
    await designControl(target, "done");
  }, [designControl]);
  const restartDesign = useCallback(async () => {
    const target = viewedPathRef.current;
    if (!target) return;
    setDesignArmed(true);
    await designControl(target, "clear");
  }, [designControl]);
  const toggleGoal = useCallback(async () => {
    // Mutual exclusion: Design armed or active blocks Goal entirely (the
    // button is disabled too; this guards programmatic callers).
    if (designArmed || designPendingSubject != null || (designStatus?.design != null && designStatus.stage !== "done")) {
      toast("info", "Finish or end the active Design first");
      return;
    }
    if (durableGoal?.active || goalPendingObjective != null) {
      // Cancel pursuit on the owning session, captured now: clicking ACTIVE
      // means "stop pursuing", never "mark done" (only the model reaching
      // the stopping condition completes). Path-addressed — the foreground
      // may move before the backend handles it.
      const target = viewedPathRef.current;
      setGoalArmed(false);
      setGoalPendingObjective(null);
      if (!target) return;
      await goalControl(target, "cancel");
      return;
    }
    setGoalArmed((armed) => !armed);
  }, [durableGoal, goalControl, goalPendingObjective, designArmed, designPendingSubject, designStatus, toast]);

  // Failed-transition attention: a thread/subagent that newly reports
  // interrupted/failed marks its owning sessions unread. Only transitions
  // observed while running count (seeded silently), so restarts and old
  // history never manufacture attention. Clears on view like any unread.
  const failedSeenRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const FAILED = new Set(["interrupted", "failed"]);
    const check = <T extends WorkSourceItem>(
      items: T[],
      idOf: (item: T) => string
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
    check(activity.threads, (t) => `thread:${t.threadId}`);
    check(activity.subagents, (s) => `subagent:${s.runId}`);
  }, [activity, markUnread]);
  // Explicit settlement: idle (or failed) sessions leave active work for the
  // Settled shelf; live work (working/waiting/approval) rejects. Persisted.
  // Settling the open session is allowed when idle: it persists, drops its
  // tab, and falls back to a neighbor tab (or stays viewing the settled
  // transcript when nothing else is open — viewing settled work is legal).
  // Event-style callbacks (useEffectEvent): stable identity for memoized
  // children and one-shot subscriptions, always reading latest state.
  // They replace the old ref mirrors (runtimeByPathRef/groupsRef/closeTabRef).
  const settleSession = useEffectEvent((path: string) => {
    const exec = runtimeByPath[path]?.execution ?? "idle";
    if (!canSettle(exec)) {
      toast("warning", "Still working — settle after this run finishes");
      return;
    }
    setSettled((prev) => {
      if (prev[path] != null) return prev;
      return { ...prev, [path]: Date.now() };
    });
    // Settled work leaves tabs and pins behind (like archive drops its pin).
    // Persistence is owned by the versioned setters; no direct writes here.
    setPinnedOrder((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : prev));
    // closeTab owns the whole transition once: removal + activeBySpace
    // repair + same-Space fallback navigation when it was the viewed tab.
    closeTab(path);
  });
  const unsettleSession = useEffectEvent((path: string) => {
    setSettled((prev) => {
      if (prev[path] == null) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
    // Return to active work means visible work: re-add its tab under the
    // owning project (opening the row un-settles the same way).
    const owner = groups
      .flatMap((g) => g.sessions.map((s) => ({ ...s, groupCwd: g.cwd })))
      .find((s) => s.path === path);
    if (owner) {
      setNavTabs((prev) => {
        const tabs = addNavTab(prev.tabs, owner.groupCwd, path);
        if (tabs === prev.tabs) return prev;
        return { ...prev, tabs };
      });
    }
  });

  const refreshSessions = useEffectEvent(async () => {
    try {
      setGroups(await bridge.listSessions());
    } catch (e) {
      // An empty list with no explanation blanks tabs and history with no
      // recourse, so that case toasts. Transient blips over a loaded list
      // keep stale data silently rather than flashing errors.
      if (process.env.NODE_ENV !== "production") console.warn("[babylon] listSessions failed:", e);
      if (groups.length === 0) toast("error", errorMessage(e, "couldn't load sessions"));
    }
  });

  // Stable identity so the memoized Sidebar does not re-render every frame.
  // Path-addressed: renames foreground, installed owner, and never-opened
  // sessions alike — the backend resolves ownership, no need to open first.
  // Prefill comes from the rename target, never the visible header.
  const renameSession = useCallback(
    async (path: string, currentName?: string) => {
      const name = await promptText({ title: "Rename chat", prefill: currentName, placeholder: "Session name" });
      if (!name) return;
      try {
        await bridge.renameSession(path, name);
        void refreshSessions();
      } catch (e) {
        toast("error", errorMessage(e, "could not rename chat"));
      }
    },
    [promptText, refreshSessions, toast]
  );

  const togglePalette = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    const apply = () => setShowCommandPalette(next);
    const doc: Document & {
      startViewTransition?: (cb: () => void) => {
        ready: Promise<unknown>;
        updateCallbackDone: Promise<unknown>;
        finished: Promise<unknown>;
      };
    } = document;
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
            transition?.[key]?.catch?.(() => {});
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
        const clamped = clampHard(width, 360, maxWidth);
        setWithFallback("context-width", String(clamped));
        return clamped;
      });
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      setContextWidth(clampWithRubberband(startWidth + startX - move.clientX, 360, maxWidth, startWidth));
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
      if (ev.type === "tabs") {
        syncBrowserTabs(ev.tabs);
      } else if (ev.type === "visibility" && ev.open) {
        takeOverBrowser();
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
    // Project settings follow the UI's active project, never a runtime
    // activation (items 62, 176).
    // Project settings are the ACTIVE PROJECT's, never a runtime's.
    const cwd = projectSettingsCwd(activeSpace);
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
  }, [activeSpace]);

  // Attention Inbox: raise an item when the agent needs the user (here, a
  // permission request). The id is keyed to the approval id so repeats of the
  // same request do not create duplicates. The user dismisses from the inbox.
  // Shared approval registration: live requests and post-reload recovery of
  // still-pending runtime approvals take the same path (inbox item + event).
  const registerApproval = useCallback(
    (req: { id: string; action: { description?: string; category?: string }; risk?: unknown }, source?: string | null) => {
      setAttention((prev) =>
        addAttention(prev, {
          id: `perm-${req.id}`,
          type: "permission",
          title: "Approval required",
          detail: req.action.description ?? req.action.category,
          // Attribution is the REQUEST's own session (resolved by the
          // caller) or the caller's explicit source. Never the viewed
          // conversation: an inbox item may be unattributed, but it must
          // never point at a random chat (C3).
          source: source ?? undefined,
          createdAt: Date.now(),
          resolved: false,
        })
      );
    },
    []
  );
  useEffect(() => {
    return bridge.onApprovalRequested((req) => {
      // The request names its own session: attribute the inbox item and the
      // execution state to THAT session, or to nothing at all.
      const { path } = planApprovalRequest(req.sessionId ?? null, sessionIdToPathRef.current);
      registerApproval(req, path);
      if (path) {
        const seq = ++runtimeSeqRef.current;
        setExecutions((prev) => applyRuntimeEvent(prev, { type: "extension_ui_request" }, { path, seq, now: Date.now() }));
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
            // Identity only: a request without a resolvable session is not
            // "the one being restored".
            if (planApprovalRequest(req.sessionId ?? null, sessionIdToPathRef.current).path !== path) continue;
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
              },
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


  // Drop the matching attention item when the approval is actually resolved
  // (allowed or denied), so the inbox stops over-reporting outstanding work.
  // The gated run resumes, so the canonical execution returns to working.
  // Resolution targets the APPROVAL's session (which may be backgrounded),
  // never blindly the viewed session.
  useEffect(() => {
    return bridge.onApprovalResolved((payload) => {
      setAttention((prev) => removeAttention(prev, `perm-${payload.id}`));
      // Identity only: a resolution without a resolvable session must not
      // mutate whatever the user happens to be looking at (item 96).
      const ap = planApprovalRequest(payload.sessionId ?? null, sessionIdToPathRef.current).path;
      if (ap) {
        const seq = ++runtimeSeqRef.current;
        const at = Date.now();
        setExecutions((prev) => resolveApprovalExecution(prev, ap, seq, at));
      }
    });
  }, []);

  // Aggregate activity/workflows are ordinary reads: load them on mount and
  // never wait for a runtime status (items 106-108).
  useEffect(() => {
    void Promise.all([bridge.activityList(), bridge.workflowsList()])
      .then(([nextActivity, nextRuns]) => {
        setActivity(nextActivity);
        setWorkflowRuns(nextRuns);
      })
      .catch(() => undefined);
  }, []);

  // Resync from the source of truth. Manual compaction doesn't fire
  // a run-end event, so without this the StatsPopover context % and the
  // transcript would stay at the pre-compaction values until the next
  // user prompt. Disk sync never emits a foreground ready (see
  // PiHost.refreshFromDisk), so a successful refresh falls through to the
  // explicit hydrate below instead of returning early.
  const resyncFromSource = useCallback(async (opts?: { skipRefresh?: boolean; forEpoch?: number; forPath?: string | null }) => {
    // Ownership captured by the caller BEFORE its own awaits (a refresh
    // handler's epoch/path from before the disk sync). Defaults to entry
    // time for direct callers (settle handler, compaction resync).
    const expectedEpoch = opts?.forEpoch ?? epochRef.current;
    const expectedPath = opts?.forPath !== undefined ? opts.forPath : viewedPathRef.current;
    try {
      const activePath = viewedPathRef.current;
      if (!opts?.skipRefresh && activePath) await bridge.refreshSession(activePath).catch(() => false);
      // A newer switch started while syncing, or the foreground moved on:
      // the data below belongs to the old session — drop it, never bind.
      if (expectedEpoch !== epochRef.current || expectedPath !== viewedPathRef.current) return;
      // Addressed reads: with no viewed session there is nothing to bind.
      if (!expectedPath) return;
      const [msgs, st, statsData, nextHistory] = await Promise.all([
        bridge.getMessages(expectedPath),
        bridge.getState(expectedPath),
        bridge.getStats(expectedPath),
        bridge.getHistory(expectedPath),
      ]);
      if (expectedEpoch !== epochRef.current || expectedPath !== viewedPathRef.current) return;
      dispatch({ type: "rebuild", messages: msgs });
      setAgentState(st);
      setStats(statsData);
      setHistory(nextHistory);
      setHistoryRevision((revision) => revision + 1);
      const rollback = nextHistory.activeRollback;
      const rollbackCreatedAt = rollback?.createdAt ?? null;
      if (rollback && rollbackCreatedAt && rollbackDraftRef.current !== rollbackCreatedAt) {
        rollbackDraftRef.current = rollbackCreatedAt;
        setDraftRequest({ id: Date.now(), text: rollback.editorText });
      } else if (!rollbackCreatedAt) {
        rollbackDraftRef.current = null;
      }
      void refreshSessions();
    } catch {
      /* session may have closed */
    }
  }, [refreshSessions]);

  useEffect(() => {
    void refreshSessions();
    return bridge.onSessionsUpdate((update) => {
      setGroups(update.groups);
      const activePath = viewedPathRef.current;
      if (
        update.source !== "host" &&
        activePath &&
        update.changedPaths.includes(activePath) &&
        !streamingRef.current &&
        !viewSwitchingRef.current
      ) {
        // Disk sync never emits a foreground ready (see PiHost.refreshFromDisk):
        // hydrate the session we display explicitly from the boolean result.
        // Never clear the active session id here. A refresh that returns
        // false emits no status, so a cleared id would blackhole the whole
        // turn's events (every agent event carries sessionId) until the next
        // explicit open. Ownership is captured BEFORE the await: a tab
        // switch that starts mid-refresh must not have its switch flag
        // cleared by this stale operation, nor receive this refresh's data.
        const refreshEpoch = epochRef.current;
        const refreshPath = activePath;
        const switchToken = claimViewSwitch();
        void bridge
          .refreshSession(activePath)
          .then((refreshed) => {
            if (
              refreshed &&
              refreshEpoch === epochRef.current &&
              refreshPath === viewedPathRef.current
            ) {
              void resyncFromSource({ skipRefresh: true, forEpoch: refreshEpoch, forPath: refreshPath });
            }
          })
          .catch(() => undefined)
          .finally(() => {
            releaseViewSwitch(switchToken);
          });
      }
    });
  }, [refreshSessions, resyncFromSource]);

  // No unconditional 1-second full reparse/hydrate loop: the SessionIndex
  // watch (300ms) + safety scan drive refreshes event-first, and every
  // refresh reparses the session file and fans out to messages/models/
  // commands/state/stats/history. An idle session must not pay that every
  // second (plus socket round trips in daemon mode).

  // When a run settles, resync from the source of truth.
  useEffect(() => {
    if (!state.settledNonce) return;
    void resyncFromSource();
  }, [state.settledNonce, resyncFromSource]);

  // PROJECT EXECUTION REGISTRY: which conversation executes, per project.
  // The ONLY ownership authority in the renderer. Seeded/refreshed from
  // executionList(), updated by execution_changed pushes, and written
  // synchronously by the renderer itself when IT calls executionActivate.
  // View navigation never writes it (C3/C7).
  const [executionsByCwd, setExecutionsByCwd] = useState<Record<string, ProjectExecution>>({});
  const refreshExecutions = useCallback(async (): Promise<ProjectExecution[]> => {
    const list = await bridge.executionList();
    setExecutionsByCwd(indexExecutions(list));
    return list;
  }, []);
  useEffect(() => {
    void refreshExecutions().catch(() => undefined);
    return bridge.onExecutionChanged((execution) =>
      setExecutionsByCwd((prev) => mergeExecution(prev, execution))
    );
  }, [refreshExecutions]);

  // Daemon socket transitions: on loss, warn (calls already fail fast with
  // explicit errors). On reconnect, EVERY project's owner is re-read from the
  // authoritative registry — several Spaces may be executing at once, so
  // nothing is pruned to whatever happens to be on screen (items 109-115).
  useEffect(() => {
    return bridge.onDaemonStatus(({ connected }) => {
      if (!connected) {
        toast("warning", "Pi runtime disconnected — reconnecting…");
        return;
      }
      toast("info", "Pi runtime reconnected");
      void refreshExecutions()
        .then((owners) => {
          // Event rows are re-derived from the registry; every project owner
          // that survived the reconnect stands, and only a viewed OWNER is
          // rehydrated.
          const outcome = reconnectExecutions(owners, viewedPathRef.current);
          setExecutions({});
          // Reuse the guarded hydrate path: it captures the current epoch and
          // path, so a view switch during the request drops the result.
          if (outcome.rehydratePath) void hydrate(epochRef.current);
        })
        .catch(() => undefined);
      void Promise.all([bridge.activityList(), bridge.workflowsList()])
        .then(([nextActivity, nextRuns]) => {
          setActivity(nextActivity);
          setWorkflowRuns(nextRuns);
        })
        .catch(() => undefined);
    });
  }, [refreshExecutions, toast]);

  // sessionId -> path mirror for resolving background events to rows.
  useEffect(() => {
    const m = new Map<string, string>();
    for (const g of groups) for (const s of g.sessions) m.set(s.id, s.path);
    // Fresh/unflushed execution sessions are not in the disk index yet; the
    // execution registry carries their identity until the next refresh.
    for (const execution of Object.values(executionsByCwd)) m.set(execution.sessionId, execution.sessionFile);
    sessionIdToPathRef.current = m;
  }, [groups, executionsByCwd]);

  // Resolve an agent event to the session path it describes (pure helper in
  // sessionRuntime; lifecycle events require a known session so stale or
  // foreign ids can never resurrect activity on the open session).
  // Events carry their own identity. There is no "active session" to fall
  // back to: a path comes from event.sessionFile, or from the sessionId index
  // (items 90, 91).
  const resolveRuntimePath = useCallback(
    (sessionId?: string | null, requireKnown = false): string | null =>
      resolveRuntimePathPure(sessionId ?? null, sessionIdToPathRef.current, requireKnown),
    []
  );

  useEffect(
    () =>
      bridge.onAgentEvents((events) => {
        // One plan, computed from each event's OWN identity. Background work is
        // unconditional; only transcript dispatch and view side effects are
        // scoped to the viewed conversation (C3/C7).
        const plan = planRuntimeEvents(events, {
          viewedSessionPath: viewedPathRef.current,
          switching: viewSwitchingRef.current,
          sessionIdToPath: sessionIdToPathRef.current,
          hasViewedSession: hasSessionRef.current,
          streamResponses: streamResponsesRef.current,
        });
        for (const event of plan.dispatch) dispatch({ type: "event", event });
        for (const { path, event } of plan.executions) {
          const seq = ++runtimeSeqRef.current;
          setExecutions((prev) => applyRuntimeEvent(prev, event, { path, seq, now: Date.now() }));
        }
        for (const path of plan.unread) markUnread(path);
        for (const sessionId of plan.settleSessionIds) {
          const goalTarget = goalTargetRef.current;
          if (goalTarget && goalTarget.sessionId === sessionId) {
            void refreshDurableGoal(goalTarget.sessionId, goalTarget.cwd);
          }
          const designTarget = designTargetRef.current;
          if (designTarget && designTarget.sessionId === sessionId) {
            void refreshDesign(designTarget.sessionId, designTarget.cwd);
          }
        }
        if (plan.refreshViewedState) {
          const statePath = viewedPathRef.current;
          if (statePath) bridge.getState(statePath).then(setAgentState).catch(() => {});
        }
        if (plan.resyncViewed) void resyncFromSource({ skipRefresh: true });
      }),
    [resyncFromSource, markUnread, refreshDurableGoal, refreshDesign]
  );

  const hydrate = useCallback(async (expectedEpoch = epochRef.current) => {
    // Cache keys captured at entry (epoch+path guarded below, so a switch
    // mid-flight drops the whole result — keys cannot leak across sessions).
    const hydratePath = viewedPathRef.current;
    const hydrateCwd = viewedCwdRef.current;
    const cachedModels = hydrateCwd != null ? modelsCacheRef.current.get(hydrateCwd) : undefined;
    try {
      const [msgs, ms, commandData, st, statsData, nextHistory] = await Promise.all([
        hydratePath ? bridge.getMessages(hydratePath) : Promise.resolve([]),
        cachedModels ??
          (hydrateCwd != null ? bridge.getModels(hydrateCwd).catch(() => null) : Promise.resolve(null)),
        hydratePath ? bridge.getCommands(hydratePath).catch(() => null) : Promise.resolve(null),
        hydratePath ? bridge.getState(hydratePath) : Promise.resolve(null),
        hydratePath ? bridge.getStats(hydratePath) : Promise.resolve(null),
        hydratePath
          ? bridge.getHistory(hydratePath)
          : Promise.resolve<HistoryProjection>({ turns: [], leafId: null, hasBranches: false }),
      ]);
      // Ownership: epoch alone does not exclude requestId-less activations
      // (a background execution change without bumping it),
      // so the session path must match too — otherwise a stale hydrate
      // writes another session's messages/state/history over the screen.
      if (expectedEpoch !== epochRef.current || hydratePath !== viewedPathRef.current) return;
      // Never wipe the on-screen transcript: append only live messages newer
      // than the last loaded one. This is what keeps big-session opens stable
      // (the live compacted view no longer replaces the file tail).
      loadedMessagesRef.current = mergeLiveMessages(loadedMessagesRef.current, msgs);
      dispatch({ type: "rebuild", messages: loadedMessagesRef.current });
      setCanLoadMore(earliestOffsetRef.current != null && earliestOffsetRef.current > 0);
      if (ms != null && cachedModels === undefined && hydrateCwd != null) {
        modelsCacheRef.current.set(hydrateCwd, ms);
      }
      setModels(ms ?? cachedModels ?? []);
      // Commands are intentionally uncached: registrations belong to the
      // runtime instance, and backend eviction/recreation is invisible here.
      setCommands(commandData ?? []);
      if (!commandData?.length && hydratePath) {
        const retryEpoch = expectedEpoch;
        const retryPath = hydratePath;
        let attempts = 6;
        const retry = async () => {
          if (retryEpoch !== epochRef.current || retryPath !== viewedPathRef.current) return;
          if (attempts-- <= 0) return;
          await new Promise<void>((r) => setTimeout(r, 400));
          if (retryEpoch !== epochRef.current || retryPath !== viewedPathRef.current) return;
          try {
            const refreshed = await bridge.getCommands(retryPath);
            if (retryEpoch !== epochRef.current || retryPath !== viewedPathRef.current) return;
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
      const rollback = nextHistory.activeRollback;
      const rollbackCreatedAt = rollback?.createdAt ?? null;
      if (rollback && rollbackCreatedAt && rollbackDraftRef.current !== rollbackCreatedAt) {
        rollbackDraftRef.current = rollbackCreatedAt;
        setDraftRequest({ id: Date.now(), text: rollback.editorText });
      } else if (!rollbackCreatedAt) {
        rollbackDraftRef.current = null;
      }
      // Thinking levels are model-defined: serve from cache while the model
      // id matches, refetch (epoch+path guarded) when it changes. Keyed by
      // model alone so evict+reopen cycles with the same model stay cached.
      // JSON-encoded tuple, not string concatenation (provider/ids are
      // matched exactly, never split ambiguously).
      const levelsKeyFor = st?.model ? JSON.stringify([st.model.provider, st.model.id]) : null;
      const cachedLevels = levelsKeyFor != null ? levelsCacheRef.current.get(levelsKeyFor) : undefined;
      if (cachedLevels !== undefined) {
        setThinkingLevels(cachedLevels);
      } else if (hydratePath) {
        const levelsEpoch = expectedEpoch;
        const levelsPath = hydratePath;
        void bridge
          .getThinkingLevels(levelsPath)
          .then((levels) => {
            if (levelsEpoch !== epochRef.current || levelsPath !== viewedPathRef.current) return;
            if (levelsKeyFor != null && levels != null) levelsCacheRef.current.set(levelsKeyFor, levels);
            setThinkingLevels(levels ?? []);
          })
          .catch(() => undefined);
      }
    } catch (e) {
      toast("error", errorMessage(e, "failed to load session"));
    }
  }, [toast]);

  const { rollbackPlan, rollbackBusy, setRollbackPlan, prepareRollback, commitRollback, undoRollback } = useRollback({
    setHistory,
    setHistoryRevision,
    setDraftRequest,
    hydrate,
    toast,
  });

  // In daemon-owned mode there is no local host to announce readiness, so
  // health IS the connection: connected → ready, reconnecting → starting.
  // Runtime health is a SHELL concern (C4): the hook's whole surface is a
  // status value and an error message. It cannot name, select, or prepare a
  // conversation, because it has no way to express one.
  const runtimeStatus = useRuntimeHealth({
    subscribe: useCallback((cb: (status: RuntimeStatus) => void) => bridge.onRuntimeStatus(cb), []),
    subscribeConnection: useCallback(
      (cb: (connected: boolean) => void) => bridge.onDaemonStatus(({ connected }) => cb(connected)),
      []
    ),
    onError: useCallback((message: string) => toast("error", message), [toast]),
  });

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
    const file = viewedSessionPath;
    if (!file) return null;
    return (
      bots.find(
        (b) =>
          (b.sessionsByProject ? Object.values(b.sessionsByProject).includes(file) : false) ||
          isBotMainSession(b, file)
      ) ?? null
    );
  }, [bots, viewedSessionPath]);
  // Staffed extras for the active project (null = unknown: keep global behavior).
  const sharedStaff = useMemo(() => {
    if (!projectSettings) return null;
    return projectSettings.settings.memberIds
      .map((id) => bots.find((b) => b.id === id))
      .filter((b): b is Bot => !!b);
  }, [projectSettings, bots]);
  const activeGroup: BotGroup | null = useMemo(() => {
    const file = viewedSessionPath;
    if (!file) return null;
    return botGroups.find((g) => isGroupRoom(g, file)) ?? null;
  }, [botGroups, viewedSessionPath]);
  // A rule-3 default chat with staff: extra-bot turns render speaker headers
  // (thinking stays visible, unlike rooms).
  const sharedSpeakers = activeGroup == null && activeBot == null && (sharedStaff?.length ?? 0) > 0;

  // Keep the per-session transcript cache fresh (skipped while a switch is in
  // flight so the previous session's items never land under the new path).
  useEffect(() => {
    if (viewSwitchingRef.current || state.streaming) return;
    const path = viewedPathRef.current;
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
  // instead of restoring the previous view. Landing is navigation: it
  // invalidates the epoch, in-flight view switch generation so an in-flight
  // open's late ready cannot resurrect its session over the landing page.
  // Renderer execution registry: hydrated from executionList() on startup
  // and reconnect, updated ONLY by execution_changed pushes (stale
  // generations rejected inside mergeExecution). View navigation never
  // writes it (I3) — Send and the historical-view composer read it.
  // Derived view/execution relationship (I-canvas): which slot this Space
  // executes in, and whether the viewed session is that slot. Consumed by
  // the Send ownership commit and the historical-view composer commit.
  const currentExecution = activeSpace ? (executionsByCwd[activeSpace] ?? null) : null;
  const viewingExecution = viewedSessionPath != null && currentExecution?.sessionFile === viewedSessionPath;

  const showLanding = useCallback(() => {
    // Landing is pure view identity: it invalidates the in-flight view switch
    // so a late disk load cannot resurrect a session, and clears view state.
    // It never reads or writes execution ownership (I3).
    ++viewSwitchGenerationRef.current;
    viewSwitchingRef.current = false;
    showViewLanding({
      epochRef,
      viewedPathRef,
      viewedCwdRef,
      hasSessionRef,
      setViewedSessionPath,
      setHasSession,
      clearArmings: clearComposerArmings,
    });
  }, [clearComposerArmings]);

  // Disk-only navigation (C7): ordinary clicks load the stored transcript and
  // register the tab — never execution activation, ownership, or runtime
  // lifetime. A conversation you look at and one that executes are unrelated.
  const viewDeps = useCallback(
    (): ViewNavigationDeps => ({
      epochRef,
      viewedPathRef,
      viewedCwdRef,
      hasSessionRef,
      setViewedSessionPath,
      setHasSession,
      setStats,
      setCommands,
      resetHistory: () => setHistory({ turns: [], leafId: null, hasBranches: false }),
      setCanLoadMore,
      rollbackDraftRef,
      setRollbackPlan,
      loadedMessagesRef,
      earliestOffsetRef,
      sessionCacheRef,
      resetTranscript: () => dispatch({ type: "reset" }),
      rebuildTranscript: (messages) => dispatch({ type: "rebuild", messages }),
      clearUnread,
      clearArmings: clearComposerArmings,
      registerTab: registerViewedSession,
      claimViewSwitch,
      releaseViewSwitch,
      evictDeadTab: (dead) => {
        setNavTabs((prev) => {
          const tabs = prev.tabs.filter((t) => t.path !== dead);
          const activeBySpace = Object.fromEntries(
            Object.entries(prev.activeBySpace).filter(([, p]) => p !== dead)
          );
          return { tabs, activeBySpace };
        });
        void refreshSessions();
      },
      showLanding,
      toast,
      bridge,
    }),
    [clearComposerArmings, registerViewedSession, refreshSessions, showLanding, toast, claimViewSwitch, releaseViewSwitch, setNavTabs]
  );

  /** View a stored session: disk transcript + selected tab + Space. Never
   *  activates Pi, changes execution ownership, or releases a runtime. */
  const viewSession = useCallback(
    (path: string, cwd: string, opts?: { quietMissing?: boolean }) => viewSessionImpl(path, cwd, viewDeps(), opts),
    [viewDeps]
  );

  // OWNER-VIEW HYDRATION: live runtime UI exists exactly when the viewed
  // conversation IS its project's execution owner. That single condition
  // replaces the old "status became ready" trigger, so a fresh New Session,
  // a returned-to-live owner, and a background transfer all hydrate
  // naturally — and a COLD historical view clears runtime-only UI instead
  // of calling reads that would reject (items 97-103).
  useEffect(() => {
    if (!viewedSessionPath || !viewingExecution) {
      setAgentState(null);
      setStats(null);
      setCommands([]);
      setThinkingLevels([]);
      return;
    }
    const epoch = epochRef.current;
    void hydrate(epoch);
    restoreApprovalsForSession(viewedSessionPath);
  }, [viewedSessionPath, viewingExecution, currentExecution?.generation]);


  // User-curated spaces (herdr): folders you add explicitly. The pi session
  // index is never auto-imported into the sidebar.
  const [spaces, setSpaces] = useVersionedState(spacesStore);
  const addSpace = useCallback(async () => {
    const cwd = await bridge.pickFolder();
    if (!cwd) return;
    setSpaces((prev) => {
      if (prev.includes(cwd)) return prev;
      return [...prev, cwd];
    });
    const latest = groups
      .find((g) => g.cwd === cwd)
      ?.sessions.slice()
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (latest) {
      await viewSession(latest.path, cwd);
    } else {
      // No sessions yet: land on the project with no session (home screen)
      // instead of auto-creating one — same as selecting an empty space.
      setActiveSpace(cwd);
      showLanding();
    }
  }, [groups, viewSession, setActiveSpace, showLanding]);
  const removeSpace = useCallback((cwd: string) => {
    setSpaces((prev) => prev.filter((c) => c !== cwd));
  }, []);
  // Tab close is pure navigation. Session history and execution lifetime
  // are independent; even the execution-owner tab may be closed while work
  // continues (I5). Closing may mutate navTabs, navigate the view within
  // the same Space, or show landing — never a runtime call, never a
  // registry change.
  const closeTab = useEffectEvent((path: string) => {
    performCloseTab(
      {
        navTabs,
        setNavTabs,
        viewedPathRef,
        sessionByPath,
        pinnedOrder,
        viewSession,
        showLanding,
        bridge,
        executionsByCwd,
      },
      path
    );
  });
  // Space selection: adopt the project context, then resume its most recently
  // active open tab — or land on the project with no session (never auto-create).
  // The resume is speculative: a remembered tab whose file was deleted outside
  // the app lands quietly instead of erroring.
  const selectSpace = useCallback((cwd: string) => {
    setActiveSpace(cwd);
    const tab = pickSpaceTab(navTabs.tabs, navTabs.activeBySpace, cwd);
    if (tab) void viewSession(tab.path, tab.cwd, { quietMissing: true });
    else showLanding();
  }, [navTabs, viewSession, setActiveSpace, showLanding]);

  // Scroll-up streaming: fetch the next older window of the stored transcript
  // and prepend it. The viewport stays put via ChatView's prepend
  // compensation; the full transcript is always mounted.
  const loadEarlier = useCallback(async () => {
    const path = viewedPathRef.current;
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

  // Every "new session" entry point opens a fresh chat directly in the
  // active project. The project picker only appears when no project is
  // active (no space selected and no session open). A folder outside the
  // list goes through the folder picker.
  const newSessionProjects = useMemo(() => {
    const byCwd = new Map(groups.map((g) => [g.cwd, g.sessions]));
    return spaces.map((cwd) => {
      const sessions = byCwd.get(cwd) ?? [];
      let lastUsed = 0;
      for (const s of sessions) if (s.mtime > lastUsed) lastUsed = s.mtime;
      return { cwd, name: cwd.split("/").filter(Boolean).pop() || cwd, lastUsed };
    });
  }, [spaces, groups]);
  // "New Session" in the execution model means: make a new conversation this
  // project's execution session. Claim FIRST, then view the concrete file it
  // produced — never optimistically switch to an unnamed fresh session: a
  // busy owner must leave the user exactly where they were (I4).
  const claimNewSession = useCallback(
    async (cwd: string): Promise<boolean> => {
      try {
        const result = await bridge.executionActivate(cwd);
        if (!result.ok) {
          toast("warning", "This project is busy — wait for the current turn before starting a new chat.");
          return false;
        }
        // Merge immediately instead of waiting for the ownership push, so
        // viewing the new owner hydrates on the very next render (item 104).
        setExecutionsByCwd((prev) => mergeExecution(prev, result.execution));
        await viewSession(result.execution.sessionFile, cwd);
        return true;
      } catch (e) {
        toast("error", errorMessage(e, "failed to start a new session"));
        return false;
      }
    },
    [toast, viewSession]
  );
  const newSession = useCallback(() => {
    const cwd = activeSpace;
    if (cwd) {
      void claimNewSession(cwd);
      return;
    }
    setShowNewSession(true);
  }, [activeSpace, claimNewSession]);
  const chooseNewSessionProject = useCallback(
    async (cwd: string) => {
      setShowNewSession(false);
      await claimNewSession(cwd);
    },
    [claimNewSession]
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
    const cwd = activeSpace;
    if (!cwd) {
      toast("info", "Open a project folder first");
      return;
    }
    try {
      const v = await bridge.projectSettingsGet(cwd);
      setProjectSettings(v);
      setShowProject(true);
    } catch (e) {
      toast("error", errorMessage(e, "could not load project settings"));
    }
  }, [projectSettings, activeSpace, toast]);

  // Switch to a different (or new) project folder.
  const openFolder = useCallback(async () => {
    const cwd = await bridge.pickFolder();
    if (!cwd) return;
    // A folder with an existing conversation is selected, not duplicated:
    // the claim only creates when the project has no execution session yet.
    const latest = groups.find((g) => g.cwd === cwd)?.sessions[0];
    if (latest) {
      await viewSession(latest.path, cwd);
      return;
    }
    await claimNewSession(cwd);
  }, [claimNewSession, groups, viewSession]);

  // Bot Mode: open a bot's canonical forever-chat. The main process opens the
  // host session (installing the persona overlay + model pin and creating the
  // canonical file on first open); the renderer then displays it through the
  // normal session path, which re-derives the same overlay by file lookup.
  const openBot = useCallback(async (bot: Bot) => {
    setPromotedParent(null);
    // The project is chosen HERE, once, and handed to the backend: the claim
    // and the view then describe the same project by construction (C2/C3).
    const requested =
      bot.cwd ?? (projectFilter !== "all" ? projectFilter : null) ?? activeSpace ?? (await bridge.pickFolder());
    if (!requested) {
      toast("info", "Pick a project folder to open the bot chat");
      return;
    }
    try {
      const result = await bridge.botsOpen(bot.id, requested);
      void bridge.botsList().then(setBots).catch(() => undefined);
      // botsOpen already claimed execution and returned the owner; viewing
      // is all that is left. The backend's cwd is authoritative.
      if (result.sessionFile) await viewSession(result.sessionFile, result.cwd);
    } catch (e) {
      // A failed claim changes nothing about the current view: there is no
      // optimistic view to undo, so leave the transcript alone.
      toast("error", errorMessage(e, "could not open bot chat"));
    }
  }, [viewSession, projectFilter, activeSpace, toast]);

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
    } catch (e) {
      toast("error", errorMessage(e, "could not delete bot"));
    }
  }, [toast]);

  // Group rooms: open the shared session through the normal display path.
  const openGroup = useCallback(async (group: BotGroup) => {
    setPromotedParent(null);
    // Same contract as bot open: the project is resolved once, here, and the
    // backend claim uses exactly it.
    const memberCwd = bots.find((b) => b.id === group.memberIds[0])?.cwd;
    const requested =
      groupChatCwd({ groupCwd: group.cwd, memberCwd, projectFilter, activeSpace }) ??
      (await bridge.pickFolder());
    if (!requested) {
      toast("info", "Pick a project folder to open the room");
      return;
    }
    try {
      const result = await bridge.groupsOpen(group.id, requested);
      void bridge.groupsList().then(setBotGroups).catch(() => undefined);
      // groupsOpen already claimed execution and returned the owner: view it,
      // never activate a second time (item 28).
      if (result.sessionFile) await viewSession(result.sessionFile, result.cwd);
    } catch (e) {
      // Nothing was viewed optimistically, so a failed claim leaves the
      // current transcript exactly as it was.
      toast("error", errorMessage(e, "could not open group room"));
    }
  }, [viewSession, projectFilter, activeSpace, toast, bots]);

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
    } catch (e) {
      toast("error", errorMessage(e, "could not delete group"));
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
      } catch (e) {
        toast("error", errorMessage(e, "could not create handoff"));
      }
    },
    [projectSettings, toast]
  );
  const consumeHandoff = useCallback(
    async (sourcePath: string) => {
      const live = viewedSessionPath;
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
      } catch (e) {
        toast("error", errorMessage(e, "could not consume handoff"));
      }
    },
    [viewedSessionPath, toast]
  );
  // Session metadata lookup for Send's busy-owner toast (the canonical
  // sessionTitle helper below is declared after send, so resolve inline —
  // module-level resolveSessionTitle has no TDZ problem in the deps list).
  const sessionByPath = useMemo(() => buildSessionByPath(groups), [groups]);

  // Send = acquire project execution ownership, then execute one turn in
  // the session captured AT SUBMISSION (src/lib/send-execution.ts). The
  // No compatibility warmup: executionActivate is the whole contract:
  // executionActivate IS the warmup, and navigation after submission is
  // presentation state — it never re-targets a submitted send (I7/I8).
  const send = useCallback(
    async (text: string, images?: Attachment[], streamingBehavior?: "steer" | "followUp"): Promise<boolean> => {
      const hasContent = Boolean(text.trim() || images?.length);
      // Execution identity captured at submission — validated immediately,
      // never re-resolved from view state after an await (I7/I8).
      const target = viewedPathRef.current;
      const cwd = viewedCwdRef.current;
      const rollbackOptimistic = () => {
        if (hasContent) dispatch({ type: "local-user-rollback", text });
      };
      try {
        // Echo the message immediately so a cold start reads as responsive.
        // The optimistic row is rolled back by whichever attempt fails.
        if (hasContent) {
          dispatch({
            type: "local-user",
            text,
            images: images?.map((image) => `data:${image.mimeType};base64,${image.data}`),
          });
          setPinNonce((n) => n + 1);
        }
        if (history.activeRollback) {
          setHistory((current) => ({ ...current, activeRollback: undefined }));
        }
        if (!target || !cwd) {
          // No submitted identity yet (fresh session still activating, or
          // no project selected): fail fast instead of guessing.
          rollbackOptimistic();
          toast("info", "The session isn't ready yet — try again in a moment");
          return false;
        }
        // Room attachments: text-only for now. Pre-flight — a doomed send
        // never acquires execution ownership.
        if (activeGroup && !streamingBehavior && images?.length) {
          rollbackOptimistic();
          toast("info", "Images stay in 1:1 chats, rooms take text for now");
          return false;
        }
        const mappedImages = images?.map((a) => ({ type: "image" as const, data: a.data, mimeType: a.mimeType }));
        const deps: SendExecutionDeps = {
          bridge,
          setPreparingTurn,
          onActivated: (execution) => setExecutionsByCwd((prev) => mergeExecution(prev, execution)),
          rollbackOptimistic,
          hydrateIfRollback: () => {
            if (history.activeRollback) void hydrate();
          },
          busyToast: (busySessionFile) => toast("info", `${resolveSessionTitle(sessionByPath, busySessionFile)} is still working`),
          activationFailedToast: (e) => toast("error", errorMessage(e, "send failed")),
          roomGroupId: activeGroup && !streamingBehavior ? activeGroup.id : null,
          goalArmed,
          designArmed,
          onGoalSubmit: () => {
            setGoalArmed(false);
            setGoalPendingObjective(text);
          },
          onDesignSubmit: () => {
            setDesignArmed(false);
            setDesignPendingSubject(text);
          },
          viewedPathRef,
        };
        let stage: SendStage;
        try {
          stage = await performSend(deps, { cwd, target, text, images: mappedImages, streamingBehavior });
        } catch (e) {
          // Turn-phase transport failure: performSend already rolled the
          // optimistic row back; only surface + settle pending displays.
          setGoalPendingObjective(null);
          setDesignPendingSubject(null);
          toast("error", errorMessage(e, "send failed"));
          return false;
        }
        if (stage.stage === "activation-failed" || stage.stage === "busy") {
          // Reactions (rollback/hydrate/toast) ran inside performSend.
          return false;
        }
        if (stage.stage === "group") {
          if (stage.room.stopped) toast("info", "Room rounds stopped");
          if (history.activeRollback) await hydrate();
          return true;
        }
        if (stage.stage === "goal") {
          // Envelope semantics unchanged: pre-start failures roll the row
          // back with the goal OFF; started turns keep row + dot.
          setGoalPendingObjective(null);
          const result = stage.result;
          if (result.goal && viewedPathRef.current === target) setDurableGoal(result.goal);
          if (result.error) {
            if (!result.started) {
              rollbackOptimistic();
              if (history.activeRollback) void hydrate();
            }
            toast("error", result.error);
            return result.started;
          }
          if (history.activeRollback) await hydrate();
          return true;
        }
        if (stage.stage === "design") {
          setDesignPendingSubject(null);
          const designResult = stage.result;
          if (designResult.design && viewedPathRef.current === target) {
            setDesignStatus({ design: designResult.design, stage: designResult.stage });
          }
          if (designResult.error) {
            if (!designResult.started) {
              rollbackOptimistic();
              if (history.activeRollback) void hydrate();
            }
            toast("error", designResult.error);
            return designResult.started;
          }
          if (history.activeRollback) await hydrate();
          return true;
        }
        // Ordinary prompt accepted: the host owns the turn.
        if (history.activeRollback) await hydrate();
        return true;
      } catch (e) {
        // Defensive: performSend owns rollback for its failures; this only
        // surfaces anything thrown outside it (echo/validation plumbing).
        setGoalPendingObjective(null);
        setDesignPendingSubject(null);
        toast("error", errorMessage(e, "send failed"));
        if (history.activeRollback) void hydrate();
        return false;
      }
    },
    [history.activeRollback, hydrate, toast, activeGroup, goalArmed, setDurableGoal, designArmed, sessionByPath]
  );

  const abort = useCallback(async () => {
    // Capture BEFORE the call: the viewed session is the only legal
    // target — no foreground/status fallback (I7/I8).
    const target = viewedPathRef.current;
    if (!target) return;
    try {
      await bridge.abort(target);
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
      } catch (e) {
        toast("error", errorMessage(e, "failed to control launch"));
      }
    },
    [toast]
  );

  const setModel = useCallback(
    async (provider: string, modelId: string) => {
      // Capture identity first; the backend enforces execution ownership.
      const target = viewedPathRef.current;
      if (!target) {
        toast("error", "No session is open");
        return;
      }
      try {
        const prev = agentState?.model;
        await bridge.setModel(target, provider, modelId);
        setAgentState(await bridge.getState(target));
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
      } catch (e) {
        toast("error", errorMessage(e, "model switch failed"));
      }
    },
    [toast, agentState, models]
  );

  const setThinking = useCallback(
    async (level: string) => {
      const target = viewedPathRef.current;
      if (!target) {
        toast("error", "No session is open");
        return;
      }
      try {
        await bridge.setThinking(target, level);
        setAgentState(await bridge.getState(target));
      } catch (e) {
        toast("error", errorMessage(e, "thinking level change failed"));
      }
    },
    [toast]
  );

  // Theme is owned by useTheme (Settings → Appearance).

  const compact = useCallback(async () => {
    const target = viewedPathRef.current;
    if (!target) return;
    try {
      await bridge.compact(target);
    } catch (e) {
      toast("error", errorMessage(e, "compaction failed"));
    }
  }, [toast]);

  const forkCurrent = useCallback(async () => {
    // Capture BEFORE the confirm dialog: navigating during the modal must
    // not retarget the fork (confirm-target contract).
    const captured = await captureTargetThen(
      () => viewedPathRef.current,
      () => confirmAction({ title: "Fork the current session into a separate session?", message: "The current session remains preserved.", confirmLabel: "Fork" }),
      async (target) => target
    );
    if (!captured) return;
    try {
      const result = await bridge.clone(captured);
      if (result.cancelled) return;
      toast("info", "Forked current session");
      await hydrate();
      await refreshSessions();
    } catch (error) {
      toast("error", errorMessage(error, "failed to fork session"));
    }
  }, [hydrate, refreshSessions, toast]);

  const activeBranch: string | undefined =
    agentState?.gitWorktree?.branch ?? agentState?.git?.branch;
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
  // The viewed conversation's identity, from ONE consistent source: the
  // session index for the path and its cwd, the live state for the id
  // (items 78, 79). Never a runtime status.
  const viewedEntry = useMemo(
    () => (viewedSessionPath ? sessionByPath.get(viewedSessionPath) ?? null : null),
    [sessionByPath, viewedSessionPath]
  );
  const viewedCwd = viewedEntry?.cwd ?? activeSpace ?? null;
  const goalSessionId =
    viewedSessionPath == null ? null : agentState?.sessionId ?? viewedEntry?.session.id ?? null;
  const goalCwd = viewedCwd;

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
        viewedSessionPath,
        projectExecutions: Object.values(executionsByCwd),
        viewedCwd: viewedSessionPath
          ? sessionByPath.get(viewedSessionPath)?.cwd ?? activeSpace ?? null
          : null,
        bots,
      }),
    [groups, executions, settled, unread, attention, activity, workflowRuns, viewedSessionPath, viewedCwd, executionsByCwd, bots]
  );

  // Per-session liveness is dead: runtimeByPath (above) owns it now.

  // ---- Spaces / Agents / Tabs nav model ----
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
        scope: activeSpace,
        resolveCwd: resolveSessionCwd,
        resolveRunCwd,
      }),
    [activity, workflowRuns, activeSpace, resolveSessionCwd, resolveRunCwd]
  );
  const sessionTitle = useCallback(
    (path: string) => resolveSessionTitle(sessionByPath, path),
    [sessionByPath]
  );

  // Viewed-vs-execution composer access: LIVE state comes from runtimeByPath
  // (event-derived, so the lock clears the moment the owner settles) with
  // executionsByCwd as the ownership/fallback registry — no new polling.
  const ownerRuntimeState = currentExecution
    ? (runtimeByPath[currentExecution.sessionFile]?.execution ?? currentExecution.state)
    : null;
  const composerAccess = deriveComposerExecutionAccess({
    viewedSessionPath,
    currentExecution,
    ownerExecutionState: ownerRuntimeState,
  });
  // Stream truth for ChatView + Composer: a hidden execution streaming never
  // leaks steer/queue/Stop/follow into another transcript (I3).
  const viewedStreaming = deriveViewedStreaming(viewingExecution, activeStreaming);
  // Tab-strip execution marker: OWNERSHIP comes from executionsByCwd
  // (currentExecution), live state from runtimeByPath colors/pulses it —
  // never the reverse (a busy runtimeByPath entry without ownership is not
  // an execution tab).
  const tabExecution = currentExecution
    ? { path: currentExecution.sessionFile, state: ownerRuntimeState ?? currentExecution.state }
    : null;
  // Return to live = pure view navigation to the CURRENT owner (I3): the
  // owner already owns execution, this only changes what ChatView shows.
  const returnToExecution = useCallback(() => {
    returnToExecutionImpl({
      currentExecution: activeSpace ? executionsByCwd[activeSpace] : null,
      viewSession,
      bridge,
      onBeforeView: () => setPromotedParent(null),
    });
  }, [activeSpace, executionsByCwd, viewSession]);
  const composerExecutionAccess = useMemo<ComposerExecutionAccessUi>(() => {
    if (composerAccess.kind === "blocked") {
      const state = ownerRuntimeState ?? currentExecution?.state ?? "working";
      return {
        kind: "blocked",
        ownerLabel: sessionTitle(composerAccess.ownerSessionFile),
        busyLabel: executionBusyLabel(state),
        onReturnToLive: returnToExecution,
      };
    }
    return { kind: composerAccess.kind };
  }, [composerAccess, ownerRuntimeState, currentExecution, sessionTitle, returnToExecution]);
  const tabItems = useMemo(
    () => buildTabItems(navTabs.tabs, sessionByPath, sessionTitle),
    [navTabs.tabs, sessionByPath, sessionTitle]
  );
  // Tabs are per project: the header only shows the active space's working
  // set. Other projects keep their tabs, restored on space switch.
  const visibleTabItems = useMemo(() => {
    const cwd = activeSpace;
    return visibleSpaceTabs(tabItems, cwd ?? null);
  }, [tabItems, activeSpace]);
  const attentionByPath = useMemo(() => buildAttentionByPath(runtimeByPath), [runtimeByPath]);
  const historyEntries = useMemo(
    () => buildHistoryEntries(groups, new Set(navTabs.tabs.map((t) => t.path))),
    [groups, navTabs.tabs]
  );
  // Agents roots come EXCLUSIVELY from executionsByCwd (ownership
  // authority); runtimeByPath only enriches an owner's live state, and
  // activity sources only contribute children under an existing root.
  const executionTrees = useMemo(
    () =>
      deriveExecutionTrees({
        executions: Object.values(executionsByCwd),
        runtimeByPath,
        threads: activity.threads,
        subagents: activity.subagents,
        workflows: workflowRuns,
        titleFor: sessionTitle,
        activeCwd: activeSpace,
      }),
    [executionsByCwd, runtimeByPath, activity.threads, activity.subagents, workflowRuns, sessionTitle, activeSpace]
  );
  const allSpaceCwds = useMemo(() => buildAllSpaceCwds(spaces, activeSpace), [spaces, activeSpace]);

  // Stable handlers for the memoized Sidebar/ChatView. Their identity must not
  // change per render (streaming ticks, keystrokes), or the memo boundary is
  // defeated and the whole subtree re-renders.
  const onOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const onToggleMinimize = useCallback(() => {
    setSidebarMinimized((minimized) => !minimized);
  }, [setSidebarMinimized]);
  const onOpenSidebarSession = useCallback(
    (path: string | undefined, cwd: string) => {
      setPromotedParent(null);
      // Existing transcript → disk-only view; an undefined path (new
      // session row) still goes through activation to create the file.
      if (path) void viewSession(path, cwd);
      // A row with no path means "new conversation in this project", which is
      // an execution claim, not a view (item 29).
      else void claimNewSession(cwd);
    },
    [claimNewSession, viewSession]
  );
  const onDeleteSession = useCallback(
    async (path: string, name: string) => {
      if (!(await confirmAction({ title: `Delete chat "${name}"?`, message: "This cannot be undone.", confirmLabel: "Delete chat", danger: true }))) return;
      try {
        await bridge.deleteSession(path);
        toast("info", "Chat deleted");
      } catch (error) {
        toast("error", errorMessage(error, "could not delete chat"));
      }
    },
    [toast]
  );
  const onSearch = useCallback(() => togglePalette(true), [togglePalette]);
  const onAddSpace = useCallback(() => void addSpace(), [addSpace]);
  const onOpenExecutionRoot = useCallback(
    (tree: ExecutionTree) => {
      // Root click = view the owning session only (I3): the root already
      // owns execution; no activation, no ownership change.
      openExecutionRoot({ viewSession, bridge, onBeforeView: () => setPromotedParent(null) }, tree);
    },
    [viewSession]
  );

  // Stable ChatView props (its `items` change per token, but unrelated App
  // renders must not re-render the transcript subtree).
  const chatOnNeedEarlier = useCallback(() => void loadEarlier(), [loadEarlier]);
  const chatOnRollback = useCallback(
    (entryId: string) => {
      // Destructive-op target is the VIEWED session, captured now — never
      // re-read after prepare's awaits.
      const target = viewedPathRef.current;
      if (!target) return;
      void prepareRollback(target, entryId);
    },
    [prepareRollback]
  );
  // Quote in composer: assistant selection arrives pre-formatted as a
  // blockquote and appends to the draft (never replaces typed text).
  const chatOnQuote = useCallback((text: string) => {
    setDraftRequest({ id: Date.now(), text, append: true });
  }, []);
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
    const cwd = activeSpace;
    return cwd ? cwd.split("/").filter(Boolean).pop() || cwd : null;
  }, [activeSpace]);

  // Strip identity follows the visible session; a change refetches the
  // durable goal (or clears the strip when nothing is open).
  useEffect(() => {
    if (!goalSessionId || !goalCwd) {
      goalTargetRef.current = null;
      setDurableGoal(null);
    } else {
      void refreshDurableGoal(goalSessionId, goalCwd);
    }
    // Design strip follows the same session.
    if (!goalSessionId || !goalCwd) {
      designTargetRef.current = null;
      setDesignStatus(null);
    } else {
      void refreshDesign(goalSessionId, goalCwd);
    }
  }, [goalSessionId, goalCwd, refreshDurableGoal, refreshDesign]);

  // The sidebar's index. Only features that render as panes appear here, because
  // a grid item has to open in the sidebar rather than somewhere else. The rest
  // of the session features are dialogs or cards and keep their own surfaces.
  const sideItems = useMemo<SessionMenuItem[]>(
    () => [
      {
        id: "browser",
        label: "Browser",
        icon: <GlobeIcon size={16} />,
        hint: "Preview pages and dev servers in an embedded tabbed browser",
      },
      {
        id: "branches",
        label: "History",
        icon: <BranchIcon size={16} />,
        hint: "Session history: branch tree and turn timeline",
      },
      {
        id: "activity",
        label: "Activity",
        icon: <LayersIcon size={16} />,
        hint: "Workflows, threads and subagents for this session",
        badge: activityBadge,
      },
      {
        id: "canvas",
        label: "Canvas",
        icon: <TemplateIcon size={16} />,
        hint: "Diagram scenes the agent and the human share, in .pi/canvas",
      },
    ],
    [activityBadge]
  );

  // Tabs for the one right sidebar. Browser tabs mirror the backend tab list:
  // the backend stays the tab manager, the strip is only its UI. The other
  // features are singletons: selecting one focuses its tab when open,
  // creates it when not (never duplicates).
  type SideFeature = "browser" | "branches" | "activity" | "canvas";
  type SideTab = { key: string; feature: SideFeature; backendTabId?: string; mermaid?: string | null };

  const [sideTabs, setSideTabs] = useState<SideTab[]>([]);
  const [activeSideTab, setActiveSideTab] = useState<string | null>(null);
  const [browserTabs, setBrowserTabs] = useState<SimTabState[]>([]);
  const sideTabCounter = useRef(0);
  const browserIdsRef = useRef<Set<string>>(new Set());
  const browserTabsRef = useRef<SimTabState[]>([]);
  const sideOpenRef = useRef(sideOpen);
  const takeOverRef = useRef(false);
  const sideTabsRef = useRef<SideTab[]>([]);
  useEffect(() => {
    sideOpenRef.current = sideOpen;
    sideTabsRef.current = sideTabs;
  });


  const browserTabKey = (id: string) => `browser:${id}`;

  const browserTabLabel = (tab: SimTabState): string => {
    if (tab.title) return tab.title;
    if (tab.url) {
      try {
        const url = new URL(tab.url);
        return url.host + (url.pathname !== "/" ? url.pathname : "");
      } catch {
        return tab.url;
      }
    }
    return "New tab";
  };

  const openFeatureTab = useCallback(
    (feature: SideFeature, opts?: { mermaid?: string }) => {
      if (feature === "browser") {
        bridge
          .simOpenTab()
          .then((tab) => {
            const key = browserTabKey(tab.id);
            browserIdsRef.current = new Set([...browserIdsRef.current, tab.id]);
            browserTabsRef.current = [...browserTabsRef.current.filter((t) => t.id !== tab.id), tab];
            setBrowserTabs(browserTabsRef.current);
            setSideTabs((prev) => (prev.some((t) => t.key === key) ? prev : [...prev, { key, feature, backendTabId: tab.id }]));
            setActiveSideTab(key);
          })
          .catch((error: unknown) => toast("error", errorMessage(error, "could not open browser tab")));
        return;
      }
      sideTabCounter.current += 1;
      const key = `tab-${sideTabCounter.current}`;
      setSideTabs((prev) => [...prev, { key, feature, mermaid: opts?.mermaid ?? null }]);
      setActiveSideTab(key);
    },
    [toast]
  );

  const focusSideTab = useCallback(
    (key: string) => {
      setActiveSideTab(key);
      const tab = sideTabs.find((t) => t.key === key);
      if (tab?.feature === "browser" && tab.backendTabId) {
        bridge.simActivate(tab.backendTabId).catch((error: unknown) => toast("error", errorMessage(error, "could not switch browser tab")));
      }
    },
    [sideTabs, toast]
  );

  // Singleton select for branches/activity/canvas: focus the open tab, else
  // create it. (Browser keeps always-new tabs; it has its own backend list.)
  const selectFeatureTab = useCallback(
    (feature: SideFeature) => {
      if (feature === "browser") {
        openFeatureTab(feature);
        return;
      }
      const existing = [...sideTabs].reverse().find((t) => t.feature === feature)?.key;
      if (existing) focusSideTab(existing);
      else openFeatureTab(feature);
    },
    [sideTabs, focusSideTab, openFeatureTab]
  );

  const closeSideTab = useCallback(
    (key: string) => {
      const tab = sideTabs.find((t) => t.key === key);
      if (!tab) return;
      if (tab.feature === "browser" && tab.backendTabId) {
        // Removal arrives through the backend tabs event, which owns the truth
        // about what still exists.
        bridge.simCloseTab(tab.backendTabId).catch((error: unknown) => toast("error", errorMessage(error, "could not close browser tab")));
        return;
      }
      const rest = sideTabs.filter((t) => t.key !== key);
      setSideTabs(rest);
      if (activeSideTab === key) {
        const last = rest[rest.length - 1];
        setActiveSideTab(last !== undefined ? last.key : null);
      }
    },
    [sideTabs, activeSideTab, toast]
  );

  const showSideGrid = useCallback(() => {
    setActiveSideTab(null);
  }, []);

  const toggleFeatureTab = useCallback(
    (feature: SideFeature) => {
      const existing = [...sideTabs].reverse().find((t) => t.feature === feature)?.key;
      if (existing && existing === activeSideTab) showSideGrid();
      else if (existing) focusSideTab(existing);
      else openFeatureTab(feature);
    },
    [sideTabs, activeSideTab, focusSideTab, openFeatureTab, showSideGrid]
  );

  const clearTabMermaid = useCallback((key: string) => {
    setSideTabs((prev) => prev.map((t) => (t.key === key ? { ...t, mermaid: null } : t)));
  }, []);

  // Reconcile sidebar browser tabs with the backend tab list. Fresh backend
  // ids take focus while the sidebar is open (a tile click, or the agent
  // opening a tab); the take-over flag covers its tab arriving while closed.
  const syncBrowserTabs = useCallback((tabs: SimTabState[]) => {
    const ids = new Set(tabs.map((t) => t.id));
    const fresh = tabs.filter((t) => !browserIdsRef.current.has(t.id));
    const removed = [...browserIdsRef.current].filter((id) => !ids.has(id));
    browserIdsRef.current = ids;
    browserTabsRef.current = tabs;
    setBrowserTabs((prev) => {
      if (
        prev.length === tabs.length &&
        prev.every((t, i) => {
          const n = tabs[i];
          return n !== undefined && t.id === n.id && t.title === n.title && t.url === n.url && t.loading === n.loading;
        })
      ) {
        return prev;
      }
      return tabs;
    });
    if (fresh.length === 0 && removed.length === 0) return;
    setSideTabs((prev) => {
      const kept = prev.filter((t) => t.feature !== "browser" || (t.backendTabId != null && ids.has(t.backendTabId)));
      if (fresh.length === 0 && kept.length === prev.length) return prev;
      return [...kept, ...fresh.map((t) => ({ key: browserTabKey(t.id), feature: "browser" as SideFeature, backendTabId: t.id }))];
    });
    const lastFresh = fresh[fresh.length - 1];
    if (fresh.length > 0 && lastFresh !== undefined && (sideOpenRef.current || takeOverRef.current)) {
      setActiveSideTab(browserTabKey(lastFresh.id));
      takeOverRef.current = false;
    } else if (removed.length > 0) {
      // A removed tab takes focus with it; fall back to the last survivor.
      const removedKeys = new Set(removed.map(browserTabKey));
      setActiveSideTab((prev) => {
        if (!prev || !removedKeys.has(prev)) return prev;
        const rest = sideTabsRef.current.filter((t) => !removedKeys.has(t.key));
        const last = rest[rest.length - 1];
        return last !== undefined ? last.key : null;
      });
    }
  }, []);

  // The agent opening the in-app browser takes over the sidebar browser tab,
  // even if its tab event has not arrived yet; the sync above converges it.
  const takeOverBrowser = useCallback(() => {
    takeOverRef.current = true;
    const tabs = browserTabsRef.current;
    const last = tabs[tabs.length - 1];
    if (tabs.length > 0 && last !== undefined) setActiveSideTab(browserTabKey(last.id));
  }, []);

  const activeTab: SideTab | null = sideTabs.find((t) => t.key === activeSideTab) ?? null;

  const stripTabs = sideTabs.map((tab) => {
    const item = sideItems.find((i) => i.id === tab.feature);
    const live = tab.feature === "browser" ? browserTabs.find((t) => t.id === tab.backendTabId) : undefined;
    return {
      key: tab.key,
      feature: tab.feature,
      label: live ? browserTabLabel(live) : (item?.label ?? tab.feature),
      icon: item?.icon ?? null,
      loading: live?.loading ?? false,
    };
  });

  // The panes are split into lazy chunks. Warm them while the grid is showing,
  // so opening one never waits on a load. Startup stays lean because nothing
  // loads until the sidebar is actually opened.
  useEffect(() => {
    if (!sideOpen || activeSideTab !== null) return;
    void import("./components/SimSidebar");
    void import("./components/BranchPanel");
    void import("./components/WorkflowsPanel");
    void import("./components/CanvasPanel");
  }, [sideOpen, activeSideTab]);

  /** Put the sidebar itself away. Backend tabs survive (as before); the next
      backend event re-lists them, which is how reopening used to re-mirror. */
  const closeSidebar = useCallback(() => {
    setSideOpen(false);
    setSideTabs([]);
    setActiveSideTab(null);
    setBrowserTabs([]);
    browserIdsRef.current = new Set();
    browserTabsRef.current = [];
    takeOverRef.current = false;
  }, [setSideOpen]);

  const canvasOpener = useMemo(
    () => ({
      openInCanvas: (code: string) => {
        openFeatureTab("canvas", { mermaid: code });
      },
    }),
    [openFeatureTab]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
        togglePalette((open: boolean) => !open);
      } else if (command && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarMinimized((minimized) => !minimized);
      } else if (command && event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleFeatureTab("activity");
        setSideOpen(true);
      } else if (command && event.shiftKey && event.key.toLowerCase() === "c") {
        // Copy the active session path (mirrors the session menu item).
        // Never hijacks typing: inputs keep their native behavior.
        const ae = document.activeElement;
        if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || (ae instanceof HTMLElement && ae.isContentEditable)) return;
        if (!viewedSessionPath) return;
        event.preventDefault();
        void navigator.clipboard?.writeText(viewedSessionPath);
        toast("info", "Copied path");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFeatureTab, viewedSessionPath, toast]);

  const onOpenTree = useCallback(() => {
    // History reads are cold-capable: a branch view never needs a live runtime.
    if (!hasSession) return;
    toggleFeatureTab("branches");
  }, [hasSession, toggleFeatureTab]);

  const chatOnOpenLaunch = useCallback(() => {
    openFeatureTab("activity");
  }, [openFeatureTab]);

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
    <CanvasProvider value={canvasOpener}>
    <div className="app-shell flex h-full">
    {settingsOpen ? (
      <Suspense fallback={null}>
      <SettingsPage
        models={models}
        projectCwd={activeSpace}
        agentState={agentState}
        theme={themePref}
        themeId={themeId}
        onThemeIdChange={setThemeId}
        onThemeChange={setThemePref}
        onClose={() => setSettingsOpen(false)}
        onSettingsSaved={() => {
          // Context-window overrides remap the registry: drop cached lists
          // so the next hydrate refetches them.
          modelsCacheRef.current.clear();
        }}
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
      {showProject && projectSettings && activeSpace ? (
        <Suspense fallback={null}>
        <ProjectPanel
          projectPath={activeSpace}
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
        activePath={viewedSessionPath ?? undefined}
        activeCwd={activeSpace ?? undefined}
        treeOpen={activeTab?.feature === "branches"}
        canOpenTree={hasSession}
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
        executionTrees={executionTrees}
        allSpaceCwds={allSpaceCwds}
        onOpenExecutionRoot={onOpenExecutionRoot}
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
            {promotedParent ? <button onClick={() => { const parent = promotedParent; setPromotedParent(null); void viewSession(parent.path, parent.cwd); }} title="Back to parent session" className="thread-action thread-action-text">← Parent</button> : null}
            <SessionTabs
              tabs={visibleTabItems}
              selectedPath={viewedSessionPath}
              execution={tabExecution}
              attentionByPath={attentionByPath}
              onActivate={(tab) => {
                setPromotedParent(null);
                void viewSession(tab.path, tab.cwd);
              }}
              onClose={(path) => closeTab(path)}
              onNew={() => newSession()}
              historyMenu={
                <SessionHistoryMenu
                  entries={historyEntries}
                  onOpen={(entry) => {
                    setPromotedParent(null);
                    void viewSession(entry.path, entry.cwd);
                  }}
                />
              }
            />
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {/* Way back into the session sidebar. It renders only while the
                  sidebar is closed, so open and close never share the row. */}
              {!sideOpen ? (
                <button
                  onClick={() => setSideOpen(true)}
                  title="Session sidebar (⌘⌥B)"
                  aria-label="Show session sidebar"
                  className="thread-action relative"
                >
                  <ListIcon size={14} />
                  {activityBadge > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 grid h-[16px] min-w-[16px] place-items-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none text-white">
                      {activityBadge}
                    </span>
                  ) : null}
                </button>
              ) : null}
            </div>
          </header>

          <div className="flex flex-1 min-h-0 flex-col">
              {hasSession ? (
                <ErrorBoundary fallback={<PaneCrashFallback name="conversation pane" />}>
                <ChatView
                  items={state.items}
                  canLoadMore={canLoadMore}
                  loadingEarlier={loadingEarlier}
                  onNeedEarlier={chatOnNeedEarlier}
                  streaming={viewedStreaming}
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
                  sessionKey={viewedSessionPath}
                  sessionCwd={viewedCwd}
                  streamResponses={streamResponses}
                  historyTurns={history.turns}
                  pinNonce={pinNonce}
                  onRollback={chatOnRollback}
                  onQuote={chatOnQuote}
                  onOpenLaunch={chatOnOpenLaunch}
                  onControlLaunch={chatOnControlLaunch}
                />
                </ErrorBoundary>
              ) : (
                <div className="flex flex-1 min-h-0 overflow-hidden">
                  <Hero
                    runtimeStatus={runtimeStatus}
                    groups={groups}
                    onOpen={(path: string, cwd: string) => {
                      // Hero rows are EXISTING conversations: viewing only.
                      // New conversations have their own button (item 30).
                      setPromotedParent(null);
                      void viewSession(path, cwd);
                    }}
                    onNew={newSession}
                    spaceCwd={activeSpace}
                  />
                </div>
              )}

            {hasSession && preparingTurn ? (
              <div className="flex items-center gap-2 px-4 pb-2 text-[13px] text-dim" role="status">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
                Preparing session…
              </div>
            ) : null}

            {hasSession ? (
              <ErrorBoundary fallback={<PaneCrashFallback name="composer pane" />}>
              <SessionFooter
                agentState={composerAccess.kind === "owner" ? agentState : null}
                stats={composerAccess.kind === "owner" ? stats : null}
                models={models}
                thinkingLevels={thinkingLevels}
                onSetModel={setModel}
                onSetThinking={setThinking}
                onCompact={compact}
                streaming={viewedStreaming}
                executionAccess={composerExecutionAccess}
                steering={state.steering}
                followUp={state.followUp}
                commands={commands}
                draftRequest={draftRequest}
                sessionKey={viewedSessionPath}
                toast={toast}
                onSend={send}
                onAbort={abort}
                dialogs={composerAccess.kind === "owner" ? state.dialogs : []}
                onDialogDismiss={(id) => dispatch({ type: "dialog-dismiss", id })}
                runningWorkflows={runningWorkflows}
                subagentCount={subagentCount}
                mentionBots={
                  activeGroup
                    ? bots.filter((b) => activeGroup.memberIds.includes(b.id))
                    : (sharedStaff ?? bots.filter((b) => !b.hidden))
                }
                goalMode={durableGoal?.active || goalPendingObjective != null ? "active" : goalArmed ? "armed" : "off"}
                goalObjective={goalPendingObjective ?? durableGoal?.objective ?? null}
                onToggleGoal={activeGroup ? undefined : () => void toggleGoal()}
                designMode={
                  designPendingSubject != null || (designStatus?.design != null && designStatus.stage !== "done")
                    ? "active"
                    : designArmed
                      ? "armed"
                      : "off"
                }
                designStage={designPendingSubject != null ? "elicit" : (designStatus?.stage ?? "idle")}
                designSubject={designPendingSubject ?? designStatus?.design?.subject ?? null}
                onToggleDesign={() => toggleDesign()}
                onEndDesign={() => void endDesign()}
                onRestartDesign={() => void restartDesign()}
                onApproveDesignBrief={() => {
                  const target = viewedPathRef.current;
                  if (!target) return;
                  void designControl(target, "approve-brief");
                }}
                onApproveDesignBrand={() => {
                  const target = viewedPathRef.current;
                  if (!target) return;
                  void designControl(target, "approve-brand");
                }}
              />
              </ErrorBoundary>
            ) : null}
          </div>
        </main>

        {/* The browser backend lives in the main process, not the daemon socket,
            so it renders on toggle alone. Branch/Activity still need the daemon. */}
        {sideOpen && activeSpace ? (
          <SessionSidebar
            width={contextWidth}
            onResizeStart={beginContextResize}
            items={sideItems}
            tabs={stripTabs}
            activeKey={activeSideTab}
            onOpen={(id) => {
              if (id === "browser" || id === "branches" || id === "activity" || id === "canvas") selectFeatureTab(id);
            }}
            onFocus={focusSideTab}
            onCloseTab={closeSideTab}
            onShowGrid={showSideGrid}
            onClose={closeSidebar}
          >
            {/* The panes load lazily. The boundary sits inside the sidebar so a
                first open blanks only the body, never the whole sidebar. */}
            <Suspense fallback={null}>
              {activeTab?.feature === "browser" ? (
                <SimSidebar />
              ) : activeTab?.feature === "branches" ? (
                <BranchPanel
                  sessionFile={viewedSessionPath}
                  onClose={() => {
                    if (activeSideTab) closeSideTab(activeSideTab);
                  }}
                  refreshToken={historyRevision}
                  onRollback={(entryId) => {
                    const target = viewedPathRef.current;
                    if (target) void prepareRollback(target, entryId);
                  }}
                  onUndoRollback={() => {
                    const target = viewedPathRef.current;
                    if (target) void undoRollback(target);
                  }}
                  onForkCurrent={() => void forkCurrent()}
                  toast={toast}
                />
              ) : activeTab?.feature === "activity" ? (
                <WorkflowsPanel
                  cwd={activeSpace}
                  resolveCwd={resolveSessionCwd}
                  resolveRunCwd={resolveRunCwd}
                  onOpenSession={(path, targetCwd, parentPath) => {
                    const cwd = targetCwd ?? activeSpace ?? viewedCwd;
                    if (cwd) {
                      // The promoted parent's project comes from explicit
                      // data, never a global status cwd (item 77).
                      if (parentPath && cwd) setPromotedParent({ path: parentPath, cwd });
                      void viewSession(path, cwd);
                    }
                    if (activeSideTab) closeSideTab(activeSideTab);
                  }}
                  onClose={() => {
                    if (activeSideTab) closeSideTab(activeSideTab);
                  }}
                  toast={toast}
                />
              ) : activeTab?.feature === "canvas" ? (
                <CanvasPanel cwd={activeSpace ?? ""} mermaid={activeTab?.mermaid ?? null} onImported={() => {
                  if (activeSideTab) clearTabMermaid(activeSideTab);
                }} />
              ) : null}
            </Suspense>
          </SessionSidebar>
        ) : null}
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
              void viewSession(path, cwd);
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
          defaultCwd={activeSpace}
          onChoose={(cwd) => void chooseNewSessionProject(cwd)}
          onPickFolder={() => {
            setShowNewSession(false);
            void openFolder();
          }}
          onClose={() => setShowNewSession(false)}
        />
      )}
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
        <GitCommitPopover cwd={activeSpace ?? undefined} onClose={() => setShowCommitPopover(false)} toast={toast} onChanged={refreshGitStatuses} />
      )}
      <DialogHost
        dialogs={state.dialogs}
        onDismiss={(id) => dispatch({ type: "dialog-dismiss", id })}
        toast={toast}
      />
      <PromptHost />
      <Toasts toasts={state.toasts} onDismiss={(id) => dispatch({ type: "toast-dismiss", id })} />

    </div>
    </CanvasProvider>
  );
}


