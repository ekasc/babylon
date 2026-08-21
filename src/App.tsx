import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { bridge, bridgeAvailable, type ActivityUpdate, type CommandInfo, type GitStatusResult, type HistoryProjection, type ProjectGroup, type RollbackPlan, type SessionMeta, type SessionStatus, type SessionWindow, type WorkflowRunSummary } from "./bridge";
import { initialState, mergeLiveMessages, reducer } from "./store";
import { shouldAcceptEvent } from "./sessionLifecycle";
import { insertCommand } from "./commands";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import Composer, { type Attachment } from "./components/Composer";
import DialogHost from "./components/DialogHost";
import Toasts from "./components/Toasts";
import Hero from "./components/Hero";
import WorkspacePane from "./components/WorkspacePane";
import { RollbackConfirm, RollbackDock } from "./components/Rollback";
import { WorktreeBanner, WorktreeModal, type WorktreeInfo } from "./components/Worktree";
import { ApprovalGate } from "./components/ApprovalGate";
import { PermissionsPanel } from "./components/PermissionsPanel";
import { PlansPanel } from "./components/PlansPanel";
import { ProcessPanel } from "./components/ProcessPanel";
import { PreviewPanel } from "./components/PreviewPanel";
import { AttentionPanel } from "./components/AttentionPanel";
import { DevicesPanel } from "./components/DevicesPanel";
import { AutomationPanel } from "./components/AutomationPanel";
import { createDeviceRegistry, type DeviceRegistry } from "./device-pairing";
import { createScheduledTaskRegistry, type ScheduledTaskRegistry } from "./automation";
import { createAutomationHistory, type AutomationHistory } from "./automation-runner";
import { addAttention, listAttention, removeAttention, type AttentionRegistry } from "./attention";
import type { Plan } from "./plans";
import type { ProcessRegistry } from "./process-model";
import type { PreviewRegistry } from "./preview-model";
import { FlaskIcon, FolderIcon, LayersIcon, MoreIcon, PiMark, ShieldIcon } from "./components/icons";

const BranchPanel = lazy(() => import("./components/BranchPanel"));
const WorkflowsPanel = lazy(() => import("./components/WorkflowsPanel"));
const CommandPalette = lazy(() => import("./components/CommandPalette"));

function shortPath(cwd?: string): string {
  if (!cwd) return "Babylon";
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}

function StatusDot({ status, working }: { status: string; working: boolean }) {
  const cls =
    status === "ready"
      ? working
        ? "bg-ok status-dot-working"
        : "bg-ok"
      : status === "starting"
        ? "animate-pulse bg-accent"
        : status === "error"
          ? "bg-err"
          : "bg-dim";
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />;
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [groups, setGroups] = useState<ProjectGroup[]>([]);

  // t3code-style sidebar state (client-persisted): pinned order, snoozed
  // (path -> wake timestamp), settled, archived, unread.
  const [pinnedOrder, setPinnedOrder] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("babylon:pinned") ?? "[]")
  );
  const [snoozed, setSnoozed] = useState<Record<string, number>>(() =>
    JSON.parse(localStorage.getItem("babylon:snoozed") ?? "{}")
  );
  const [settled, setSettled] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("babylon:settled") ?? "[]")
  );
  // Explicitly woken threads: override the stale-timer auto-settle.
  const [unsettled, setUnsettled] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("babylon:unsettled") ?? "[]")
  );
  useEffect(() => { localStorage.setItem("babylon:unsettled", JSON.stringify(unsettled)); }, [unsettled]);
  useEffect(() => { localStorage.setItem("babylon:settled", JSON.stringify(settled)); }, [settled]);
  // Threads are settled only after being idle this long (not the instant a run ends).
  const STALE_SETTLE_MS = 30 * 60 * 1000;
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const [archived, setArchived] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("babylon:archived") ?? "[]")
  );
  const [unread, setUnread] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("babylon:unread") ?? "[]")
  );
  const [showArchived, setShowArchived] = useState(false);

  const toggleStringArray =
    (key: string, setter: React.Dispatch<React.SetStateAction<string[]>>) => (path: string) =>
      setter((prev) => {
        const next = prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path];
        localStorage.setItem(key, JSON.stringify(next));
        return next;
      });
  const togglePin = useCallback((path: string) => {
    setPinnedOrder((prev) => {
      const next = prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path];
      localStorage.setItem("babylon:pinned", JSON.stringify(next));
      return next;
    });
  }, []);
  const reorderPinned = useCallback((order: string[]) => {
    setPinnedOrder(order);
    localStorage.setItem("babylon:pinned", JSON.stringify(order));
  }, []);
  const toggleSnooze = useCallback((path: string, until?: number) => {
    setSnoozed((prev) => {
      const next = { ...prev };
      if (until == null || Number.isNaN(until)) delete next[path];
      else next[path] = until;
      localStorage.setItem("babylon:snoozed", JSON.stringify(next));
      return next;
    });
  }, []);
  const toggleUnread = useCallback(toggleStringArray("babylon:unread", setUnread), []);
  const toggleArchive = useCallback(
    (path: string) => {
      setArchived((prev) => {
        const next = prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path];
        localStorage.setItem("babylon:archived", JSON.stringify(next));
        return next;
      });
      // Archiving also drops the pin so it doesn't linger in the Pinned section.
      setPinnedOrder((prev) => {
        if (!prev.includes(path)) return prev;
        const next = prev.filter((p) => p !== path);
        localStorage.setItem("babylon:pinned", JSON.stringify(next));
        return next;
      });
    },
    []
  );
  const toggleShowArchived = useCallback(() => setShowArchived((v) => !v), []);
  const copySession = useCallback((kind: "path" | "id" | "branch", session: SessionMeta) => {
    const value =
      kind === "path" ? session.path : kind === "id" ? session.id : session.cwd;
    void navigator.clipboard?.writeText(value);
    toast("info", `Copied ${kind}`);
  }, []);
  const [status, setStatus] = useState<SessionStatus>({ status: "idle" });
  const [projectFilter, setProjectFilter] = useState("all");
  const [models, setModels] = useState<any[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [agentState, setAgentState] = useState<any>(null);
  const [gitStatuses, setGitStatuses] = useState<Record<string, GitStatusResult>>({});
  const [stats, setStats] = useState<any>(null);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [worktreeInfo, setWorktreeInfo] = useState<WorktreeInfo | null>(null);
  const [showWorktreeModal, setShowWorktreeModal] = useState(false);
  const [showBranchPanel, setShowBranchPanel] = useState(false);
  const [showWorkflowsPanel, setShowWorkflowsPanel] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showPermissions, setShowPermissions] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const [showProcesses, setShowProcesses] = useState(false);
  const [processRegistry, setProcessRegistry] = useState<ProcessRegistry>({ processes: {} });
  const [showPreview, setShowPreview] = useState(false);
  const [previewRegistry, setPreviewRegistry] = useState<PreviewRegistry>({ servers: {} });
  const [showAttention, setShowAttention] = useState(false);
  const [attention, setAttention] = useState<AttentionRegistry>({ items: {} });
  const [showDevices, setShowDevices] = useState(false);
  const [devices, setDevices] = useState<DeviceRegistry>(() => createDeviceRegistry());
  const [showAutomation, setShowAutomation] = useState(false);
  const [schedule, setSchedule] = useState<ScheduledTaskRegistry>(createScheduledTaskRegistry);
  const [automationHistory, setAutomationHistory] = useState<AutomationHistory>(createAutomationHistory);
  const [history, setHistory] = useState<HistoryProjection>({ turns: [], leafId: null, hasBranches: false });
  const [historyRevision, setHistoryRevision] = useState(0);
  const [rollbackPlan, setRollbackPlan] = useState<RollbackPlan | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [contextWidth, setContextWidth] = useState(() => {
    const stored = Number(localStorage.getItem("pideck:context-width"));
    return Number.isFinite(stored) && stored >= 360 && stored <= 760 ? stored : 520;
  });
  const [sidebarMinimized, setSidebarMinimized] = useState(() => localStorage.getItem("pideck:sidebar-minimized") === "1");
  const [draftRequest, setDraftRequest] = useState<{ id: number; text: string } | null>(null);
  const [promotedParent, setPromotedParent] = useState<{ path: string; cwd: string } | null>(null);
  // Optimistic active session: set synchronously on click so the sidebar row
  // highlights instantly; the host's status confirm later keeps it exact.
  const [activeSessionPath, setActiveSessionPath] = useState<string | null>(null);

  // Settled view = explicit settles ∪ stale idle threads (not the open thread).
  // Explicit wakes override the stale timer; the active thread is never auto-settled.
  const settledView = useMemo(() => {
    const activePath = activeSessionPath ?? status.sessionPath;
    const pinnedSet = new Set(pinnedOrder);
    const archivedSet = new Set(archived);
    const out = new Set<string>();
    for (const g of groups) {
      for (const s of g.sessions) {
        const p = s.path;
        if (p === activePath) continue;
        if (pinnedSet.has(p)) continue;
        if (snoozed[p] != null) continue;
        if (archivedSet.has(p)) continue;
        if (unsettled.includes(p)) continue;
        if (settled.includes(p)) { out.add(p); continue; }
        if (nowTick - (s.mtime ?? 0) > STALE_SETTLE_MS) out.add(p);
      }
    }
    return [...out];
  }, [groups, activeSessionPath, status.sessionPath, pinnedOrder, snoozed, archived, settled, unsettled, nowTick]);

  const toggleSettle = useCallback((path: string) => {
    const isSettled = settledView.includes(path);
    if (isSettled) {
      setSettled((prev) => prev.filter((p) => p !== path));
      setUnsettled((prev) => (prev.includes(path) ? prev : [...prev, path]));
    } else {
      setUnsettled((prev) => prev.filter((p) => p !== path));
      setSettled((prev) => (prev.includes(path) ? prev : [...prev, path]));
    }
  }, [settledView]);

  const renameSession = (path: string) => {
    const name = window.prompt("Rename chat");
    if (!name) return;
    if (path === activeSessionPath) {
      void bridge.setSessionName(name);
      return;
    }
    toast("info", "Open the chat to rename it");
  };
  // Optimistic header title: shown instantly from the clicked row, replaced by
  // the host's sessionName when it hydrates.
  const [headerName, setHeaderName] = useState<string | null>(null);
  // "Preparing…" only appears if the host stays not-ready past a beat — fast
  // switches (now <100ms) never flash it; cold first-opens still get the hint.
  const [preparingVisible, setPreparingVisible] = useState(false);
  // How many chat items ChatView mounts; the window is a suffix that grows
  // upward when older transcript windows stream in.
  const [renderCap, setRenderCap] = useState(Number.MAX_SAFE_INTEGER);
  // Whether a stored-transcript window older than the current one exists.
  const [canLoadMore, setCanLoadMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [activity, setActivity] = useState<ActivityUpdate>({ threads: [], subagents: [] });
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSummary[]>([]);
  const [wtBusy, setWtBusy] = useState(false);
  // `hasSession` = a session's content is on screen (preview or live).
  // `liveReady` = the pi process is live on that session. Opening a session
  // flips hasSession immediately (instant file preview); liveReady follows
  // once the in-process switch completes — no Hero flash, no blocking.
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
  // Stored-transcript windows: the messages currently in view plus the byte
  // offset of the oldest loaded one, so scrolling to the top streams exactly
  // the preceding window instead of the whole file. The transcript only ever
  // grows (older windows prepend, live messages append), never shrinks, which
  // is what keeps big-session opens free of wipe-flicker.
  const loadedMessagesRef = useRef<any[]>([]);
  const earliestOffsetRef = useRef<number | null>(null);
  const renderCapRef = useRef(Number.MAX_SAFE_INTEGER);
  const loadingMoreRef = useRef(false);
  // Per-session transcript cache (bounded LRU, opencode's SESSION_CACHE
  // pattern): switching back renders from memory instead of re-reading the
  // file, and the host re-warms in the background.
  const sessionCacheRef = useRef(new Map<string, { messages: any[]; earliestOffset: number | null; canLoadMore: boolean }>());
  const prefetchingRef = useRef(new Set<string>());
  const streamingRef = useRef(false);
  const hasSessionRef = useRef(false);
  const rollbackDraftRef = useRef<string | null>(null);
  hasSessionRef.current = hasSession;
  liveReadyRef.current = liveReady;
  streamingRef.current = state.streaming;

  const toast = useCallback(
    (type: "info" | "warning" | "error", text: string) =>
      dispatch({ type: "toast", toast: { type, text } }),
    []
  );

  const refreshSessions = useCallback(async () => {
    try {
      setGroups(await bridge.listSessions());
    } catch {
      /* sessions dir may not exist yet */
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowCommandPalette((open) => !open);
      } else if (command && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarMinimized((minimized) => {
          localStorage.setItem("pideck:sidebar-minimized", minimized ? "0" : "1");
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
    event.preventDefault();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = contextWidth;
    event.currentTarget.setPointerCapture(pointerId);
    const target = event.currentTarget;
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const next = Math.max(360, Math.min(760, startWidth + startX - move.clientX));
      setContextWidth(next);
    };
    const onEnd = (end: PointerEvent) => {
      if (end.pointerId !== pointerId) return;
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onEnd);
      target.removeEventListener("pointercancel", onEnd);
      setContextWidth((width) => {
        localStorage.setItem("pideck:context-width", String(width));
        return width;
      });
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onEnd);
    target.addEventListener("pointercancel", onEnd);
  }, [contextWidth]);

  useEffect(() => {
    const offActivity = bridge.onActivityUpdate(setActivity);
    const offWorkflows = bridge.onWorkflowsUpdate((update) => setWorkflowRuns(update.runs));
    return () => {
      offActivity();
      offWorkflows();
    };
  }, []);

  // Attention Inbox: raise an item when the agent needs the user (here, a
  // permission request). The id is keyed to the approval id so repeats of the
  // same request do not create duplicates. The user dismisses from the inbox.
  useEffect(() => {
    return bridge.onApprovalRequested((req) => {
      setAttention((prev) =>
        addAttention(prev, {
          id: `perm-${req.id}`,
          type: "permission",
          title: "Approval required",
          detail: req.action.description ?? req.action.category,
          source: activeSessionPath ?? status.sessionPath ?? undefined,
          createdAt: Date.now(),
          resolved: false,
        })
      );
    });
  }, [activeSessionPath, status.sessionPath]);

  // Drop the matching attention item when the approval is actually resolved
  // (allowed or denied), so the inbox stops over-reporting outstanding work.
  useEffect(() => {
    return bridge.onApprovalResolved((payload) => {
      setAttention((prev) => removeAttention(prev, `perm-${payload.id}`));
    });
  }, []);

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
        switchingRef.current = true;
        activeSessionIdRef.current = null;
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

  useEffect(
    () =>
      bridge.onAgentEvents((events) => {
        if (!hasSessionRef.current) return;
        const context = {
          activeSessionId: activeSessionIdRef.current,
          switching: switchingRef.current,
        };
        let stateChanged = false;
        for (const event of events) {
          if (shouldAcceptEvent(event, context)) dispatch({ type: "event", event });
          if (
            event?.type === "agent_settled" ||
            event?.type === "agent_end" ||
            event?.type === "session_info_changed"
          ) {
            stateChanged = true;
          }
        }
        // Reflect engine-side state changes (model/thinking toggles, /fast,
        // session renames) in the status bar without waiting for the next
        // model/thinking/compact round-trip.
        if (stateChanged) bridge.getState().then(setAgentState).catch(() => {});
      }),
    []
  );

  // Chunked transcript rendering: the full transcript is projected once (a
  // couple of ms) and `rebuild` keeps the store consistent, but ChatView only
  // mounts a growing window of items per event-loop tick. A huge stored
  // transcript never blocks the main thread with one multi-hundred-millisecond
  // React commit. Scheduling uses a MessageChannel (the same trick as React's
  // scheduler): rAF stalls when the window is occluded or minimized, which
  // would freeze hydration mid-way.
  const scheduleTranscript = useCallback((messages: any[], epoch: number) => {
    const CHUNK = 400;
    // First paint is a small suffix window (the latest ~150 messages mount in
    // ~15ms), then the window grows upward in the background. Keeps a switch
    // to a big session perceptually instant while never freezing the thread.
    const INITIAL_WINDOW = 150;
    dispatch({ type: "rebuild", messages });
    if (messages.length <= INITIAL_WINDOW) {
      setRenderCap(Number.MAX_SAFE_INTEGER);
      renderCapRef.current = Number.MAX_SAFE_INTEGER;
      return;
    }
    setRenderCap(INITIAL_WINDOW);
    renderCapRef.current = INITIAL_WINDOW;
    const channel = new MessageChannel();
    let visible = INITIAL_WINDOW;
    channel.port1.onmessage = () => {
      if (epoch !== epochRef.current) return;
      visible += CHUNK;
      // The window is a suffix: it grows upward toward older messages, so a
      // bottom-pinned viewport never jumps while a big transcript mounts.
      if (visible >= messages.length) {
        setRenderCap(Number.MAX_SAFE_INTEGER);
        renderCapRef.current = Number.MAX_SAFE_INTEGER;
        return;
      }
      setRenderCap(visible);
      renderCapRef.current = visible;
      channel.port2.postMessage(null);
    };
    channel.port2.postMessage(null);
  }, []);

  // Grow the suffix window after older messages are prepended, so the newly
  // loaded region becomes visible while the current viewport stays put.
  const growRenderCap = useCallback((by: number) => {
    setRenderCap((current) => {
      const next = current >= Number.MAX_SAFE_INTEGER / 2 ? current : current + by;
      renderCapRef.current = next;
      return next;
    });
  }, []);

  const hydrate = useCallback(async (expectedEpoch = epochRef.current) => {
    try {
      const [msgs, ms, commandData, st, statsData, wt, nextHistory] = await Promise.all([
        bridge.getMessages(),
        bridge.getModels(),
        bridge.getCommands(),
        bridge.getState(),
        bridge.getStats(),
        bridge.worktreeInfo(),
        bridge.getHistory(),
      ]);
      if (expectedEpoch !== epochRef.current) return;
      // Never wipe the on-screen transcript: append only live messages newer
      // than the last loaded one. This is what keeps big-session opens stable
      // (the live compacted view no longer replaces the file tail).
      loadedMessagesRef.current = mergeLiveMessages(loadedMessagesRef.current, msgs);
      scheduleTranscript(loadedMessagesRef.current, expectedEpoch);
      setCanLoadMore(earliestOffsetRef.current != null && earliestOffsetRef.current > 0);
      setModels(ms ?? []);
      setCommands(commandData ?? []);
      setAgentState(st);
      setStats(statsData);
      setWorktreeInfo(wt);
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
          void hydrate(epochRef.current);
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
    [hydrate, toast]
  );

  // Git status keyed by project cwd, so every non-settled thread can show its
  // branch (and full status on hover). Refreshed when the session list or
  // active project changes, on a light timer, and on row hover.
  const refreshGitStatuses = useCallback(() => {
    const cwds = Array.from(new Set(groups.map((g) => g.cwd).filter(Boolean))) as string[];
    if (!cwds.length) return;
    Promise.all(
      cwds.map((c) => bridge.gitStatus(c).then((s) => [c, s] as const).catch(() => [c, null] as const))
    )
      .then((results) => {
        setGitStatuses((prev) => {
          const next = { ...prev };
          for (const [c, s] of results) if (s) next[c] = s;
          return next;
        });
      })
      .catch(() => undefined);
  }, [groups]);

  const refreshGitStatusForCwd = useCallback((cwd: string) => {
    bridge.gitStatus(cwd).then((s) => { if (s) setGitStatuses((prev) => ({ ...prev, [cwd]: s })); }).catch(() => {});
  }, []);

  useEffect(() => { refreshGitStatuses(); }, [refreshGitStatuses]);
  useEffect(() => {
    const id = window.setInterval(refreshGitStatuses, 30_000);
    return () => window.clearInterval(id);
  }, [refreshGitStatuses]);

  // Predictive fetch (kills the serial IPC from the click path): hovering a
  // sidebar row warms its tail into the LRU cache, so a click is a fully
  // synchronous swap — no await, one batched paint.
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

  // When a run settles, resync from the source of truth.
  useEffect(() => {
    if (!state.settledNonce) return;
    (async () => {
      const expectedEpoch = epochRef.current;
      try {
        const activePath = activePathRef.current;
        if (activePath && (await bridge.refreshSession(activePath))) return;
        const [msgs, st, statsData, wt, nextHistory] = await Promise.all([
          bridge.getMessages(),
          bridge.getState(),
          bridge.getStats(),
          bridge.worktreeInfo(),
          bridge.getHistory(),
        ]);
        if (expectedEpoch !== epochRef.current) return;
        scheduleTranscript(msgs, expectedEpoch);
        setAgentState(st);
        setStats(statsData);
        setWorktreeInfo(wt);
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
    })();
  }, [state.settledNonce, refreshSessions]);

  // Clear the switch cover shortly after it fades (animation is 120ms; the
  // timeout also covers the reduced-motion path where no animation fires). The
  const openSession = useCallback(
    async (path: string | undefined, cwd: string, displayName?: string) => {
      const expectedEpoch = ++epochRef.current;
      const requestId = ++latestRequestRef.current;
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
      // a recently-viewed session renders from memory — no fetch, no re-read —
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
      // empty chat while we switch — `reset` + `rebuild` batch into one render
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
      setWorktreeInfo(null);
      setHistory({ turns: [], leafId: null, hasBranches: false });
      rollbackDraftRef.current = null;
      setRollbackPlan(null);
      dispatch({ type: "reset" });
      if (memo) {
        // Render from memory; the host re-warms below.
        scheduleTranscript(memo.messages, expectedEpoch);
      } else {
        loadedMessagesRef.current = cached?.messages ?? [];
        earliestOffsetRef.current = cached?.startOffset ?? null;
        setCanLoadMore(cached != null && cached.startOffset > 0);
        if (cached?.messages.length) scheduleTranscript(cached.messages, expectedEpoch);
      }
      try {
        await bridge.openSession({ path, cwd, requestId });
      } catch (e: any) {
        if (expectedEpoch !== epochRef.current) return;
        switchingRef.current = false;
        toast("error", e?.message ?? "failed to open session");
        setHasSession(false);
        setLiveReady(false);
      }
    },
    [toast]
  );

  // Scroll-up streaming: fetch the next older window of the stored transcript
  // and prepend it, growing the suffix window so the newly loaded region is
  // visible while the current viewport stays put.
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
      const added = older.messages.length;
      loadedMessagesRef.current = [...older.messages, ...loadedMessagesRef.current];
      earliestOffsetRef.current = older.startOffset;
      setCanLoadMore(older.startOffset > 0);
      scheduleTranscript(loadedMessagesRef.current, epoch);
      growRenderCap(added);
    } catch {
      /* file may have moved; the trigger simply stops firing */
    } finally {
      if (epoch === epochRef.current) {
        loadingMoreRef.current = false;
        setLoadingEarlier(false);
      }
    }
  }, [growRenderCap, scheduleTranscript]);

  // Codex-style: with a project open, "new session" starts a chat in it — no
  // folder dialog. Only prompt for a folder when no project is open yet.
  const newSession = useCallback(async () => {
    const target = projectFilter !== "all" ? projectFilter : status.cwd;
    if (target) {
      await openSession(undefined, target);
      return;
    }
    const cwd = await bridge.pickFolder();
    if (cwd) await openSession(undefined, cwd);
  }, [openSession, status.cwd, projectFilter]);

  // New chat inside a specific listed project.
  const newSessionIn = useCallback(
    async (cwd: string) => {
      await openSession(undefined, cwd);
    },
    [openSession]
  );

  // Switch to a different (or new) project folder.
  const openFolder = useCallback(async () => {
    const cwd = await bridge.pickFolder();
    if (cwd) await openSession(undefined, cwd);
  }, [openSession]);

  const send = useCallback(
    async (text: string, images?: Attachment[], streamingBehavior?: "steer" | "followUp"): Promise<boolean> => {
      try {
        // If the agent is still warming, wait only for the matching open request.
        // A ready/error from an older serialized switch must not release this send.
        if (!liveReadyRef.current) {
          const expectedEpoch = epochRef.current;
          const requestId = latestRequestRef.current;
          await new Promise<void>((resolve, reject) => {
            const off = bridge.onStatus((s) => {
              if (expectedEpoch !== epochRef.current) {
                off();
                reject(new Error("session changed before the message could be sent"));
                return;
              }
              if (s.requestId !== undefined && s.requestId !== requestId) return;
              if (s.status === "ready") {
                off();
                resolve();
              } else if (s.status === "exited" || s.status === "error") {
                off();
                reject(new Error(s.message ?? "session failed to open"));
              }
            });
          });
        }
        if (text.trim() || images?.length) {
          dispatch({
            type: "local-user",
            text,
            images: images?.map((image) => `data:${image.mimeType};base64,${image.data}`),
          });
        }
        if (history.activeRollback) {
          setHistory((current) => ({ ...current, activeRollback: undefined }));
        }
        await bridge.prompt(
          text,
          images?.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType })),
          streamingBehavior
        );
        if (history.activeRollback) await hydrate();
        return true;
      } catch (e: any) {
        toast("error", e?.message ?? "send failed");
        if (history.activeRollback) void hydrate();
        return false;
      }
    },
    [history.activeRollback, hydrate, toast]
  );

  const abort = useCallback(async () => {
    try {
      await bridge.abort();
    } catch {
      /* ignore */
    }
  }, []);

  const setModel = useCallback(
    async (provider: string, modelId: string) => {
      try {
        await bridge.setModel(provider, modelId);
        setAgentState(await bridge.getState());
      } catch (e: any) {
        toast("error", e?.message ?? "model switch failed");
      }
    },
    [toast]
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

  const compact = useCallback(async () => {
    try {
      await bridge.compact();
    } catch (e: any) {
      toast("error", e?.message ?? "compaction failed");
    }
  }, [toast]);

  const exitWorktree = useCallback(
    async (keep: boolean) => {
      if (
        !keep &&
        !window.confirm(
          "Discard this worktree?\n\nThe worktree session (and its git worktree + pideck/* branch, if one was created) will be deleted.\n\nYour original session is untouched."
        )
      ) {
        return;
      }
      setWtBusy(true);
      try {
        const res = await bridge.worktreeExit({ keep });
        toast(
          "info",
          keep
            ? "Back on the original session — worktree kept"
            : `Worktree discarded${res.gitRemoved ? " (git worktree removed)" : ""}`
        );
      } catch (e: any) {
        toast("error", e?.message ?? "failed to exit worktree");
      } finally {
        setWtBusy(false);
      }
    },
    [toast]
  );

  const prepareRollback = useCallback(async (entryId: string) => {
    try {
      setRollbackPlan(await bridge.prepareRollback(entryId));
    } catch (error: any) {
      toast("error", error?.message ?? "rollback is unavailable");
    }
  }, [toast]);

  const commitRollback = useCallback(async () => {
    if (!rollbackPlan || rollbackBusy) return;
    setRollbackBusy(true);
    try {
      const result = await bridge.commitRollback(rollbackPlan.planId);
      setRollbackPlan(null);
      setHistory(result.history);
      setHistoryRevision((revision) => revision + 1);
      setDraftRequest({ id: Date.now(), text: result.editorText });
      await hydrate();
      toast("info", "Conversation and files rolled back");
    } catch (error: any) {
      toast("error", error?.message ?? "rollback failed");
    } finally {
      setRollbackBusy(false);
    }
  }, [rollbackBusy, rollbackPlan, hydrate, toast]);

  const undoRollback = useCallback(async () => {
    if (rollbackBusy) return;
    setRollbackBusy(true);
    try {
      const result = await bridge.undoRollback();
      setHistory(result.history);
      setHistoryRevision((revision) => revision + 1);
      setDraftRequest({ id: Date.now(), text: "" });
      await hydrate();
      toast("info", "Rollback undone");
    } catch (error: any) {
      toast("error", error?.message ?? "could not undo rollback");
      void hydrate();
    } finally {
      setRollbackBusy(false);
    }
  }, [rollbackBusy, hydrate, toast]);

  const forkCurrent = useCallback(async () => {
    if (!window.confirm("Fork the current session into a separate session?\n\nThe current session remains preserved.")) return;
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
  const liveAgentState: "running" | "blocked" | "needs-input" | "done" = state.streaming
    ? "running"
    : activity.threads.some((t) => t.status === "interrupted") ||
        activity.subagents.some((s) => s.status === "interrupted")
      ? "blocked"
      : workflowRuns.some((r) => r.status === "paused")
        ? "needs-input"
        : "done";
  const activeBranch: string | undefined =
    (agentState?.gitWorktree?.branch as string | undefined) ??
    (agentState?.git?.branch as string | undefined);
  const bannerVisible = hasSession && liveReady && !!worktreeInfo?.isWorktree;
  const liveActivityCount =
    workflowRuns.filter((run) => run.status === "pending" || run.status === "running" || run.status === "paused").length +
    activity.threads.filter((thread) => ["queued", "starting", "running", "interrupting"].includes(thread.status)).length +
    activity.subagents.filter((run) => run.status === "running").length;
  const contextOpen = showWorkflowsPanel || showBranchPanel;
  const unresolvedAttention = listAttention(attention).length;

  // Preload/bridge missing (e.g. renderer opened outside Electron, or the
  // preload script failed to load). Previously `window.pideck` was accessed
  // unconditionally, every effect threw, React unmounted the tree, and the
  // window went blank — no UI, no error. Render a visible screen instead.
  if (!bridgeAvailable) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="w-full max-w-md text-center">
          <PiMark size={44} className="mx-auto text-accent" />
          <h1 className="mt-4 text-xl font-semibold">Babylon</h1>
          <p className="mt-1 text-[13px] text-dim">Renderer bridge unavailable</p>
          <p className="mt-4 rounded-xl border border-warn/40 bg-warn/10 p-4 text-[12.5px] leading-relaxed text-fg/80">
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
      <Sidebar
        groups={groups}
        activePath={activeSessionPath ?? status.sessionPath}
        activeCwd={status.cwd}
        treeOpen={showBranchPanel}
        canOpenTree={ready && hasSession}
        minimized={sidebarMinimized}
        onToggleMinimize={() =>
          setSidebarMinimized((minimized) => {
            localStorage.setItem("pideck:sidebar-minimized", minimized ? "0" : "1");
            return !minimized;
          })
        }
        onPrefetch={prefetchSession}
        onOpen={(path, cwd, name) => {
          setPromotedParent(null);
          void openSession(path, cwd, name);
        }}
        onNew={newSession}
        onNewSessionIn={newSessionIn}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
        onDeleteSession={async (path, name) => {
          if (!window.confirm(`Delete chat “${name}”? This cannot be undone.`)) return;
          try {
            await bridge.deleteSession(path);
            toast("info", "Chat deleted");
          } catch (error: any) {
            toast("error", error?.message ?? "could not delete chat");
          }
        }}
        onOpenFolder={openFolder}
        onOpenTree={() => {
          if (!ready || !hasSession) return;
          setShowBranchPanel((open) => !open);
          setShowWorkflowsPanel(false);
        }}
        onSearch={() => setShowCommandPalette(true)}
        pinnedOrder={pinnedOrder}
        snoozed={snoozed}
        settled={settledView}
        archived={archived}
        unread={unread}
        showArchived={showArchived}
        activeStreaming={hasSession && state.streaming}
        agentState={liveAgentState}
        activeBranch={activeBranch}
        gitStatuses={gitStatuses}
        onRefreshGitStatus={refreshGitStatusForCwd}
        onReorderPinned={reorderPinned}
        onTogglePin={togglePin}
        onToggleSnooze={toggleSnooze}
        onToggleSettle={toggleSettle}
        onToggleUnread={toggleUnread}
        onToggleArchive={toggleArchive}
        onRename={renameSession}
        onCopy={copySession}
        onToggleShowArchived={toggleShowArchived}
      />

      <div className="flex min-w-0 flex-1">
        <main className="primary-workspace relative min-w-0 flex-1">
          <div className="absolute inset-0">
            {hasSession ? (
              <ChatView
                items={state.items}
                renderCount={renderCap}
                canLoadMore={canLoadMore}
                loadingEarlier={loadingEarlier}
                onNeedEarlier={() => void loadEarlier()}
                streaming={state.streaming}
                chromeTop={bannerVisible ? 110 : 72}
                chromeBottom={history.activeRollback ? 226 : 156}
                historyTurns={history.turns}
                onRollback={(entryId) => void prepareRollback(entryId)}
              />
            ) : (
              <Hero status={status} groups={groups} onOpen={(path, cwd) => { setPromotedParent(null); void openSession(path, cwd); }} onNew={newSession} />
            )}
          </div>

          <header className="thread-header titlebar absolute inset-x-0 top-0 z-10 flex h-16 items-center gap-3 px-5">
            {promotedParent ? <button onClick={() => { const parent = promotedParent; setPromotedParent(null); void openSession(parent.path, parent.cwd); }} title="Back to parent session" className="thread-action px-2 text-[13px]">← Parent</button> : null}
            <StatusDot status={liveReady ? "ready" : status.status} working={state.streaming} />
            <div className="min-w-0 flex items-baseline gap-2.5">
              <div className="truncate text-[15px] font-semibold tracking-[-0.01em]">
                {headerName ?? agentState?.sessionName ?? (hasSession ? "Untitled session" : "Babylon")}
              </div>
              <div className="truncate text-[13px] text-dim">
                {hasSession && status.cwd ? shortPath(status.cwd) : "Choose a project to begin"}
              </div>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {hasSession && worktreeInfo?.isWorktree ? <span className="execution-context"><FlaskIcon size={13} /> Worktree</span> : null}
              {hasSession ? (
                <button
                  onClick={() => {
                    setShowWorkflowsPanel((open) => !open);
                    setShowBranchPanel(false);
                  }}
                  title="Activity — workflows, threads, subagents"
                  aria-pressed={showWorkflowsPanel}
                  className={`thread-action relative ${showWorkflowsPanel ? "is-active" : ""}`}
                >
                  <LayersIcon size={16} />
                  {liveActivityCount > 0 ? <span className="sidebar-count absolute -right-1 -top-1">{liveActivityCount}</span> : null}
                </button>
              ) : null}
              {hasSession ? (
                <button onClick={() => setShowWorktreeModal(true)} title="Session and worktree actions" className="thread-action">
                  <MoreIcon size={16} />
                </button>
              ) : null}
              <button
                onClick={() => setShowPermissions((open) => !open)}
                title="Agent permissions"
                aria-pressed={showPermissions}
                className={`thread-action ${showPermissions ? "is-active" : ""}`}
              >
                <ShieldIcon size={16} />
              </button>
              <button
                onClick={() => setShowPlans((open) => !open)}
                title="Structured plans"
                aria-pressed={showPlans}
                className={`thread-action ${showPlans ? "is-active" : ""}`}
              >
                Plans
              </button>
              <button
                onClick={() => setShowProcesses((open) => !open)}
                title="Tracked processes"
                aria-pressed={showProcesses}
                className={`thread-action ${showProcesses ? "is-active" : ""}`}
              >
                Term
              </button>
              <button
                onClick={() => setShowPreview((open) => !open)}
                title="Browser preview"
                aria-pressed={showPreview}
                className={`thread-action ${showPreview ? "is-active" : ""}`}
              >
                Preview
              </button>
              <button
                onClick={() => setShowAttention((open) => !open)}
                title="Attention inbox"
                aria-pressed={showAttention}
                className={`thread-action relative ${showAttention ? "is-active" : ""}`}
              >
                Attn
                {unresolvedAttention > 0 ? (
                  <span className="sidebar-count absolute -right-1 -top-1">{unresolvedAttention}</span>
                ) : null}
              </button>
              <button
                onClick={() => setShowDevices((open) => !open)}
                title="Paired devices"
                aria-pressed={showDevices}
                className={`thread-action ${showDevices ? "is-active" : ""}`}
              >
                Devices
              </button>
              <button
                onClick={() => setShowAutomation((open) => !open)}
                title="Scheduled tasks"
                aria-pressed={showAutomation}
                className={`thread-action ${showAutomation ? "is-active" : ""}`}
              >
                Auto
              </button>
              <button onClick={() => setShowCommandPalette(true)} title="Search and commands (⌘K)" className="thread-action">
                <FolderIcon size={16} />
              </button>
            </div>
            {preparingVisible ? <span className="shrink-0 text-[13px] text-dim">Preparing…</span> : null}
          </header>

          {bannerVisible ? (
            <div className="absolute inset-x-0 top-16 z-10">
              <WorktreeBanner info={worktreeInfo!} busy={wtBusy} onExit={exitWorktree} />
            </div>
          ) : null}

          {hasSession ? (
            <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col">
              {history.activeRollback ? (
                <RollbackDock rollback={history.activeRollback} busy={rollbackBusy} onUndo={() => void undoRollback()} />
              ) : null}
              <Composer
                streaming={state.streaming}
                steering={state.steering}
                followUp={state.followUp}
                commands={commands}
                agentState={agentState}
                stats={stats}
                models={models}
                thinkingLevels={thinkingLevels}
                draftRequest={draftRequest}
                cwd={status.cwd}
                gitStatus={status.cwd ? gitStatuses[status.cwd] ?? null : null}
                onGitChanged={refreshGitStatuses}
                toast={toast}
                onSend={send}
                onAbort={abort}
                onSetModel={setModel}
                onSetThinking={setThinking}
                onCompact={compact}
              />
            </div>
          ) : null}
        </main>

        <Suspense fallback={null}>
          {ready && contextOpen ? (
            <WorkspacePane width={contextWidth} onResizeStart={beginContextResize}>
              {showBranchPanel ? (
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
            onClose={() => setShowCommandPalette(false)}
            onNew={() => void newSession()}
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
      {ready && showWorktreeModal && worktreeInfo && (
        <WorktreeModal info={worktreeInfo} onClose={() => setShowWorktreeModal(false)} toast={toast} />
      )}
      {showPermissions ? <PermissionsPanel onClose={() => setShowPermissions(false)} /> : null}
      {showPlans ? (
        <PlansPanel plans={plans} setPlans={setPlans} onClose={() => setShowPlans(false)} />
      ) : null}
      {showProcesses ? (
        <ProcessPanel
          registry={processRegistry}
          setRegistry={setProcessRegistry}
          onClose={() => setShowProcesses(false)}
        />
      ) : null}
      {showPreview ? (
        <PreviewPanel
          registry={previewRegistry}
          setRegistry={setPreviewRegistry}
          onClose={() => setShowPreview(false)}
        />
      ) : null}
      {showAttention ? (
        <AttentionPanel
          registry={attention}
          setRegistry={setAttention}
          onClose={() => setShowAttention(false)}
        />
      ) : null}
      {showDevices ? (
        <DevicesPanel
          registry={devices}
          setRegistry={setDevices}
          onClose={() => setShowDevices(false)}
          pairingCrypto={{
            newToken: () =>
              Array.from(crypto.getRandomValues(new Uint8Array(16)))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join(""),
            hash: async (token) => {
              const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
              return Array.from(new Uint8Array(bytes))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
            },
          }}
        />
      ) : null}
      {showAutomation ? (
        <AutomationPanel
          schedule={schedule}
          setSchedule={setSchedule}
          history={automationHistory}
          onClose={() => setShowAutomation(false)}
        />
      ) : null}
      <ApprovalGate />
      {rollbackPlan ? (
        <RollbackConfirm
          plan={rollbackPlan}
          busy={rollbackBusy}
          onCancel={() => !rollbackBusy && setRollbackPlan(null)}
          onConfirm={() => void commitRollback()}
        />
      ) : null}

      <DialogHost
        dialogs={state.dialogs}
        onDismiss={(id) => dispatch({ type: "dialog-dismiss", id })}
        toast={toast}
      />
      <Toasts toasts={state.toasts} onDismiss={(id) => dispatch({ type: "toast-dismiss", id })} />
    </div>
  );
}
