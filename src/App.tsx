import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { bridge, bridgeAvailable, type ActivityUpdate, type CommandInfo, type GitStatusResult, type HistoryProjection, type ProjectGroup, type ProjectSettings, type RollbackPlan, type SessionMeta, type SessionStatus, type SessionWindow, type WorkflowRunSummary } from "./bridge";
import type { Bot, BotGroup, BotPatch, DefaultBot, NewBotInput, NewGroupInput } from "./bots";
import { isBotMainSession, isGroupRoom } from "./bots";
import { initialState, mergeLiveMessages, reducer } from "./store";
import { isAgentLive, shouldAcceptEvent } from "./sessionLifecycle";
import { insertCommand } from "./commands";
import Sidebar, { type AgentDockItem } from "./components/Sidebar";
import SettingsPage from "./components/SettingsPage";
import { applyMonoFont, applySystemFonts, applyTheme, applyThemeId, loadMonoFontPref, loadSystemFontsPref, loadThemeId, loadThemePref, type ThemeId, type ThemePref } from "./lib/theme";
import ProjectFilter from "./components/ProjectFilter";
import { getNumberWithFallback, getWithFallback } from "./lib/storage";
import { getNumberWithFallbackEffect, getWithFallbackEffect } from "./lib/storage.effect";
import { normalizeProjectPathForDispatch } from "./lib/path";
import { normalizeProjectPathForDispatchEffect } from "./lib/path.effect";
import * as Effect from "effect/Effect";
import ChatView from "./components/ChatView";
import Composer, { type Attachment } from "./components/Composer";
import DialogHost from "./components/DialogHost";
import Toasts from "./components/Toasts";
import Hero from "./components/Hero";
import BotsPanel, { BotAvatar } from "./components/BotsPanel";
import ProjectPanel from "./components/ProjectPanel";
import WorkspacePane from "./components/WorkspacePane";
import { RollbackConfirm, RollbackDock } from "./components/Rollback";
import SessionFooter from "./components/SessionFooter";
import { ApprovalGate } from "./components/ApprovalGate";
import GitCommitPopover from "./components/GitCommitPopover";
// Overlay panels are rarely needed at boot; lazy-load them so they stay out
// of the startup bundle.
const PreviewPanel = lazy(() => import("./components/PreviewPanel").then((m) => ({ default: m.PreviewPanel })));
const AttentionPanel = lazy(() => import("./components/AttentionPanel").then((m) => ({ default: m.AttentionPanel })));
const DiagnosticsPanel = lazy(() => import("./components/DiagnosticsPanel").then((m) => ({ default: m.DiagnosticsPanel })));
import { collectDiagnosticsEffect } from "./diagnostics.effect";
import { PromptHost, confirmAction, promptText } from "./lib/prompts";
import { createAttentionRegistryEffect } from "./attention.effect";
import { defaultPolicyEffect } from "./background-policy.effect";
import { appendEvent, createBabylonEvent, createEventLog, type BabylonEvent, type BabylonEventType, type EventLog } from "./events";
import { stampOwnership } from "./ownership";

/** Map pi engine events onto the Babylon event catalog (diagnostics only). */
function mapAgentEventType(type: unknown): BabylonEventType | null {
  switch (type) {
    case "agent_start":
      return "turn.started";
    case "agent_end":
      return "turn.completed";
    case "tool_execution_start":
      return "tool.started";
    case "tool_execution_end":
      return "tool.completed";
    case "pideck_checkpoint_created":
      return "checkpoint.created";
    default:
      return null;
  }
}

/**
 * Build a Babylon event from a real Pi engine event. Ownership uses the
 * runtime identity carried by the event itself (sessionId, toolCallId), never
 * whichever session happens to be open in the UI. Payloads stay flat ids and
 * flags; no prompt text or tool output ever enters the log.
 */
function babylonEventFromAgentEvent(event: any): BabylonEvent | null {
  const type = mapAgentEventType(event?.type);
  if (!type) return null;
  const sessionId =
    typeof event.sessionId === "string" && event.sessionId ? event.sessionId : undefined;
  const toolCallId =
    typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : undefined;
  const owner = stampOwnership({
    ...(sessionId ? { sessionId } : {}),
    ...(toolCallId ? { toolRunId: toolCallId } : {}),
  });
  const payload: Record<string, string | number | boolean> = {};
  if (toolCallId && (type === "tool.started" || type === "tool.completed")) {
    payload.toolCallId = toolCallId;
  }
  if (type === "tool.completed" && typeof event.isError === "boolean") {
    payload.isError = event.isError;
  }
  if (type === "checkpoint.created" && typeof event.userEntryId === "string" && event.userEntryId) {
    payload.id = event.userEntryId;
  }
  return createBabylonEvent(type, { owner, payload });
}
import { addAttention, listAttention, removeAttention, type AttentionRegistry } from "./attention";
import type { PreviewRegistry } from "./preview-model";
import { createPreviewRegistryEffect } from "./preview-model.effect";
import { BellIcon, ChevronIcon, FolderIcon, LayersIcon, MoreIcon, PiMark } from "./components/icons";

const BranchPanel = lazy(() => import("./components/BranchPanel"));
const WorkflowsPanel = lazy(() => import("./components/WorkflowsPanel"));
const CommandPalette = lazy(() => import("./components/CommandPalette"));

function shortCwd(cwd?: string | null) {
  if (!cwd) return "";
  const normalized = Effect.runSync(normalizeProjectPathForDispatchEffect(cwd));
  return normalized.replace(/^\/Users\/[^/]+/, "~");
}

function StatusDot({ status, working }: { status: string; working: boolean }) {
  const label = status === "ready" ? (working ? "Working" : "Ready") : status === "starting" ? "Starting" : status === "error" ? "Error" : status;
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
  return <span role="status" aria-label={`Agent status: ${label}`} title={label} className={`inline-block h-2 w-2 rounded-full ${cls}`} />;
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  // Bot Mode: named specialists with a canonical forever-chat each.
  const [bots, setBots] = useState<Bot[]>([]);
  const [showBots, setShowBots] = useState(false);
  const [appDefaultBot, setAppDefaultBot] = useState<DefaultBot | null>(null);
  const [showProject, setShowProject] = useState(false);
  // Group rooms: one shared session where member bots take serial turns.
  const [botGroups, setBotGroups] = useState<BotGroup[]>([]);
  // Per-project bots: settings snapshot for the active project (default copy,
  // staffed roster, free-speak). Null until loaded; when absent (daemon mode,
  // bridge gaps) the UI keeps today's global behavior.
  const [projectSettings, setProjectSettings] = useState<{ settings: ProjectSettings; hash: string } | null>(null);

  // t3code-style sidebar state (client-persisted): pinned order, snoozed
  // (path -> wake timestamp), archived, unread.
  const [pinnedOrder, setPinnedOrder] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("babylon:pinned") ?? "[]")
  );
  const [snoozed, setSnoozed] = useState<Record<string, number>>(() =>
    JSON.parse(localStorage.getItem("babylon:snoozed") ?? "{}")
  );
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
  // Explicitly opened tabs per space (herdr). Every successfully opened
  // session registers here; tabs stay open until closed. Bounded per space.
  const [openTabs, setOpenTabs] = useState<Record<string, string[]>>(() =>
    JSON.parse(localStorage.getItem("babylon:tabs") ?? "{}")
  );
  const addOpenTab = useCallback((cwd: string, path: string) => {
    setOpenTabs((prev) => {
      const list = [...(prev[cwd] ?? [])];
      if (!list.includes(path)) list.push(path);
      while (list.length > 12) list.shift();
      const next = { ...prev, [cwd]: list };
      localStorage.setItem("babylon:tabs", JSON.stringify(next));
      return next;
    });
  }, []);

  const [models, setModels] = useState<any[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themePref, setThemePref] = useState<ThemePref>(loadThemePref);
  const [themeId, setThemeId] = useState<ThemeId>(loadThemeId);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [agentState, setAgentState] = useState<any>(null);
  const [gitStatuses, setGitStatuses] = useState<Record<string, GitStatusResult>>({});
  const [stats, setStats] = useState<any>(null);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [showBranchPanel, setShowBranchPanel] = useState(false);
  const [showCommitPopover, setShowCommitPopover] = useState(false);
  const [showWorkflowsPanel, setShowWorkflowsPanel] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  const [panelsMenuOpen, setPanelsMenuOpen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewRegistry, setPreviewRegistry] = useState<PreviewRegistry>(() =>
    Effect.runSync(createPreviewRegistryEffect),
  );
  const [showAttention, setShowAttention] = useState(false);
  const [attention, setAttention] = useState<AttentionRegistry>(() =>
    Effect.runSync(createAttentionRegistryEffect),
  );
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [eventLog, setEventLog] = useState<EventLog>(createEventLog);

  // Append a batch of Babylon events to the diagnostics log. Invalid events
  // are skipped (appendEvent returns the reason); the log stays bounded so a
  // long session cannot grow it without limit.
  const appendEvents = useCallback((incoming: BabylonEvent[]) => {
    if (incoming.length === 0) return;
    setEventLog((prev) => {
      let next = prev;
      for (const e of incoming) {
        const out = appendEvent(next, e);
        if (typeof out !== "string") next = out;
      }
      return next.events.length > 500 ? { events: next.events.slice(-500) } : next;
    });
  }, []);

  const [history, setHistory] = useState<HistoryProjection>({ turns: [], leafId: null, hasBranches: false });
  const [historyRevision, setHistoryRevision] = useState(0);
  const [rollbackPlan, setRollbackPlan] = useState<RollbackPlan | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [contextWidth, setContextWidth] = useState(() => {
    const stored = Effect.runSync(getNumberWithFallbackEffect("context-width", NaN));
    return Number.isFinite(stored) && stored >= 360 && stored <= 1100 ? stored : 520;
  });

  const [sidebarMinimized, setSidebarMinimized] = useState(() => Effect.runSync(getWithFallbackEffect("sidebar-minimized")) === "1");
  const [draftRequest, setDraftRequest] = useState<{ id: number; text: string } | null>(null);
  const [promotedParent, setPromotedParent] = useState<{ path: string; cwd: string } | null>(null);
  // Optimistic active session: set synchronously on click so the sidebar row
  // highlights instantly; the host's status confirm later keeps it exact.
  const [activeSessionPath, setActiveSessionPath] = useState<string | null>(null);

  const renameSession = async (path: string) => {
    const name = await promptText({ title: "Rename chat", prefill: headerName ?? undefined, placeholder: "Session name" });
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
  // "Preparing…" only appears if the host stays not-ready past a beat, fast
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
  useEffect(() => { hasSessionRef.current = hasSession; }, [hasSession]);
  useEffect(() => { liveReadyRef.current = liveReady; }, [liveReady]);
  useEffect(() => { streamingRef.current = state.streaming; }, [state.streaming]);

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

  const togglePalette = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    const apply = () => setShowCommandPalette(next as any);
    const doc: any = document as any;
    if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(apply);
    else apply();
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
          localStorage.setItem("babylon:sidebar-minimized", minimized ? "0" : "1");
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
        localStorage.setItem("babylon:context-width", String(width));
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
    return () => {
      offActivity();
      offWorkflows();
    };
  }, []);

  // Bot Mode roster: initial load + live push from the main-process store.
  useEffect(() => {
    bridge.botsList().then(setBots).catch(() => undefined);
    return bridge.onBotsUpdate(setBots);
  }, []);
  useEffect(() => {
    if (!showBots) return;
    bridge.botsDefaultGet().then(setAppDefaultBot).catch(() => undefined);
  }, [showBots]);
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
  useEffect(() => {
    return bridge.onApprovalRequested((req) => {
      appendEvents([createBabylonEvent("approval.requested", { payload: { id: req.id } })]);
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
  }, [activeSessionPath, status.sessionPath, appendEvents]);

  // Drop the matching attention item when the approval is actually resolved
  // (allowed or denied), so the inbox stops over-reporting outstanding work.
  useEffect(() => {
    return bridge.onApprovalResolved((payload) => {
      appendEvents([
        createBabylonEvent("approval.resolved", {
          payload: { id: payload.id, decision: payload.choice },
        }),
      ]);
      setAttention((prev) => removeAttention(prev, `perm-${payload.id}`));
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

  // Chunked transcript windowing disabled per user report of "section"
  // feeling while both above/below load. Was: suffix window of 150 then
  // MessageChannel chunks of 400 growing upward. Now: mount full transcript
  // immediately; large sessions may briefly block but scroll is stable and
  // the user is never stuck in a middle window.
  const scheduleTranscript = useCallback((messages: any[], epoch: number) => {
    dispatch({ type: "rebuild", messages });
    setRenderCap(Number.MAX_SAFE_INTEGER);
    renderCapRef.current = Number.MAX_SAFE_INTEGER;
    return;
    // Legacy chunked path kept for reference (disabled):
    // const CHUNK = 400;
    // const INITIAL_WINDOW = 150;
    // if (messages.length <= INITIAL_WINDOW) {
    //   setRenderCap(Number.MAX_SAFE_INTEGER);
    //   return;
    // }
    // setRenderCap(INITIAL_WINDOW);
  }, []);

  // No-op now that windowing is disabled, was: grow suffix window when
  // older messages prepended. Keeping the function for `loadEarlier` call
  // site but it no longer adjusts `renderCap` (always MAX).
  const growRenderCap = useCallback((_by: number) => {}, []);

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
      scheduleTranscript(msgs, expectedEpoch);
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
  }, [refreshSessions, scheduleTranscript]);

  // When a run settles, resync from the source of truth.
  useEffect(() => {
    if (!state.settledNonce) return;
    void resyncFromSource();
  }, [state.settledNonce, resyncFromSource]);

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
          if (shouldAcceptEvent(event, context)) dispatch({ type: "event", event });
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
    [appendEvents, resyncFromSource]
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
      scheduleTranscript(loadedMessagesRef.current, expectedEpoch);
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
          if (s.sessionPath && s.cwd) addOpenTab(s.cwd, s.sessionPath);
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

  // Git status keyed by project cwd, so every thread can show its
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

  // Clear the switch cover shortly after it fades (animation is 120ms; the
  // timeout also covers the reduced-motion path where no animation fires). The
  const openSession = useCallback(
    async (path: string | undefined, cwd: string, displayName?: string) => {
      const expectedEpoch = ++epochRef.current;
      const requestId = ++latestRequestRef.current;
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
        if (prevPath) {
          activePathRef.current = prevPath;
          setActiveSessionPath(prevPath);
          loadedMessagesRef.current = prevMessages;
          earliestOffsetRef.current = prevOffset;
          setCanLoadMore(prevOffset != null && prevOffset > 0);
          if (prevMessages.length) scheduleTranscript(prevMessages, expectedEpoch);
        } else {
          setHasSession(false);
          setLiveReady(false);
        }
      }
    },
    [toast]
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
    await openSession(latest?.path, cwd);
  }, [groups, openSession]);
  const removeSpace = useCallback((cwd: string) => {
    setSpaces((prev) => {
      const next = prev.filter((c) => c !== cwd);
      localStorage.setItem("babylon:spaces", JSON.stringify(next));
      return next;
    });
  }, []);
  // Explicit tab close (herdr): the tab goes away, the session stays on disk
  // and in Search. Closing the active tab falls back to its neighbor.
  const closeTab = useCallback((cwd: string, path: string) => {
    setOpenTabs((prev) => {
      const list = (prev[cwd] ?? []).filter((p) => p !== path);
      const next = { ...prev };
      if (list.length) next[cwd] = list;
      else delete next[cwd];
      localStorage.setItem("babylon:tabs", JSON.stringify(next));
      return next;
    });
    if (path === activePathRef.current) {
      const remaining = (openTabs[cwd] ?? []).filter((p) => p !== path);
      const pinnedHere = pinnedOrder.filter(
        (p) => !remaining.includes(p) && groups.some((g) => g.sessions.some((s) => s.path === p && s.cwd === cwd))
      );
      const nextPath = remaining[remaining.length - 1] ?? pinnedHere[pinnedHere.length - 1];
      if (nextPath) {
        for (const g of groups) {
          const s = g.sessions.find((x) => x.path === nextPath);
          if (s) {
            void openSession(s.path, s.cwd);
            break;
          }
        }
      }
    }
  }, [openTabs, pinnedOrder, groups, openSession]);

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

  // Codex-style: with a project open, "new session" starts a chat in it, no
  // folder dialog. Only prompt for a folder when no project is open yet.
  // Note: this deliberately has no forever-chat guard. Bot chats and group
  // rooms persist (reopening one resumes the same file), but New session is
  // the escape hatch: it always leaves the room and starts a fresh project
  // chat. Compacting a room is the explicit Compact action instead, the old
  // reroute trapped users in fresh rooms with "Nothing to compact" errors
  // and no way to start a session in another project.
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
  const sendBotMessage = useCallback(async (targetId: string, text: string) => {
    const result = await bridge.botsMessage(targetId, text, activeBot?.id);
    if (result.pass) {
      const target = bots.find((b) => b.id === targetId);
      toast("info", `@${target?.name ?? "bot"} had nothing to add`);
    }
  }, [activeBot?.id, bots, toast]);

  const send = useCallback(
    async (text: string, images?: Attachment[], streamingBehavior?: "steer" | "followUp"): Promise<boolean> => {
      try {
        // If the agent is still warming, wait only for the matching open request.
        // A ready/error from an older serialized switch must not release this send.
        if (!liveReadyRef.current) {
          const expectedEpoch = epochRef.current;
          const requestId = latestRequestRef.current;
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
        if (text.trim() || images?.length) dispatch({ type: "local-user-rollback", text });
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

  // Jump to a live agent from the sidebar dock (herdr): promote its thread
  // or subagent into an openable session, or reveal the workflows panel.
  const openAgentItem = useCallback(
    async (a: AgentDockItem) => {
      try {
        if (a.kind === "thread") {
          const r = await bridge.threadsPromote(a.id);
          await openSession(r.sessionFile, r.cwd);
        } else if (a.kind === "subagent") {
          const r = await bridge.subagentsPromote(a.id);
          await openSession(r.sessionFile, r.cwd);
        } else {
          setShowWorkflowsPanel(true);
          setShowBranchPanel(false);
        }
      } catch (e: any) {
        toast("error", e?.message ?? "could not open agent");
      }
    },
    [openSession, toast]
  );

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

  // Theme is owned here (Settings → Appearance) and applied on change.
  useEffect(() => {
    applyTheme(themePref);
  }, [themePref]);
  useEffect(() => {
    applyThemeId(themeId);
  }, [themeId]);

  useEffect(() => {
    applySystemFonts(loadSystemFontsPref());
    applyMonoFont(loadMonoFontPref());
    applyThemeId(loadThemeId());
    void bridge.getSettings().then((s) => {
      const enabled = s?.appearance?.useSystemFonts ?? true;
      const family = s?.appearance?.monoFontFamily ?? "system";
      applySystemFonts(enabled);
      applyMonoFont(family);
      applyThemeId(loadThemeId());
      localStorage.setItem("babylon:useSystemFonts", String(enabled));
      localStorage.setItem("babylon:monoFont", family);
      const themeFromSettings = s?.appearance?.theme;
      if (themeFromSettings === "light" || themeFromSettings === "dark" || themeFromSettings === "system") {
        applyTheme(themeFromSettings);
        setThemePref(themeFromSettings);
      }
    }).catch(() => undefined);
  }, []);

  const compact = useCallback(async () => {
    try {
      await bridge.compact();
    } catch (e: any) {
      toast("error", e?.message ?? "compaction failed");
    }
  }, [toast]);

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
  const liveActivityCount =
    workflowRuns.filter((run) => run.status === "pending" || run.status === "running" || run.status === "paused").length +
    activity.threads.filter((thread) => ["queued", "starting", "running", "interrupting"].includes(thread.status)).length +
    activity.subagents.filter((run) => run.status === "running").length;
  const runningWorkflows = workflowRuns.filter((r) => r.status === "running" || r.status === "paused").length;
  const subagentCount = activity.subagents.length;
  // Agents dock (herdr-style): live threads/subagents/workflows with an
  // owning session each, so the sidebar can jump to them or stop them.
  const agentDockItems = useMemo((): AgentDockItem[] => {
    const items: AgentDockItem[] = [];
    const pathToCwd = new Map<string, string>();
    const idToPath = new Map<string, string>();
    for (const g of groups) {
      for (const s of g.sessions) {
        pathToCwd.set(s.path, s.cwd);
        idToPath.set(s.id, s.path);
      }
    }
    for (const t of activity.threads) {
      if (!["queued", "starting", "running", "interrupting"].includes(t.status) && t.status !== "interrupted") continue;
      const sp = t.sessionFile ?? t.parentSessionFile ?? null;
      items.push({
        kind: "thread",
        id: t.threadId,
        label: t.name ?? t.goal ?? t.threadId.slice(0, 8),
        status: t.status === "interrupted" ? "blocked" : "running",
        sessionPath: sp,
        cwd: t.cwd ?? (sp ? pathToCwd.get(sp) : undefined),
      });
    }
    for (const s of activity.subagents) {
      if (s.status !== "running" && s.status !== "starting" && s.status !== "interrupted") continue;
      const sp = s.sessionFile ?? s.parentSessionFile ?? null;
      items.push({
        kind: "subagent",
        id: s.runId,
        label: s.name ?? s.task ?? s.runId.slice(0, 8),
        status: s.status === "interrupted" ? "blocked" : "running",
        sessionPath: sp,
        cwd: sp ? pathToCwd.get(sp) : undefined,
      });
    }
    for (const r of workflowRuns) {
      if (r.status !== "pending" && r.status !== "running" && r.status !== "paused") continue;
      const sp = r.sessionId ? (idToPath.get(r.sessionId) ?? null) : null;
      items.push({
        kind: "workflow",
        id: r.runId,
        label: r.description ? `${r.workflowName}, ${r.description}` : r.workflowName,
        status: r.status === "paused" ? "needs-input" : "running",
        sessionPath: sp,
        cwd: sp ? pathToCwd.get(sp) : undefined,
      });
    }
    return items;
  }, [activity, workflowRuns, groups]);
  // Per-session liveness (opencode-style): the active transcript's streaming
  // plus background threads / subagents / workflows matched to their owning
  // session file. Sidebar rows read this so a run in another project still
  // shows a dot after you switch away. Falls back to done when unknown.
  const sessionStatusMap = useMemo(() => {
    const map: Record<string, { streaming: boolean; agentStatus: "running" | "blocked" | "needs-input" | "done" }> = {};
    const activePath = activeSessionPath ?? status.sessionPath ?? undefined;
    const ensure = (path: string) => (map[path] ??= { streaming: false, agentStatus: "done" });
    if (activePath && (state.streaming || agentState?.isStreaming === true)) {
      ensure(activePath).streaming = true;
      ensure(activePath).agentStatus = "running";
    }
    const sessionIdToPath = new Map<string, string>();
    for (const g of groups) for (const s of g.sessions) sessionIdToPath.set(s.id, s.path);
    const markRunning = (path: string | null | undefined) => {
      if (!path) return;
      ensure(path).streaming = true;
      ensure(path).agentStatus = "running";
    };
    const markBlocked = (path: string | null | undefined) => {
      if (!path) return;
      const e = ensure(path);
      if (e.agentStatus === "done") e.agentStatus = "blocked";
    };
    for (const t of activity.threads) {
      const paths = [t.sessionFile, t.parentSessionFile].filter(Boolean) as string[];
      if (["queued", "starting", "running", "interrupting"].includes(t.status)) paths.forEach(markRunning);
      else if (t.status === "interrupted") paths.forEach(markBlocked);
    }
    for (const s of activity.subagents) {
      const paths = [s.sessionFile, s.parentSessionFile].filter(Boolean) as string[];
      if (s.status === "running") paths.forEach(markRunning);
      else if (s.status === "interrupted") paths.forEach(markBlocked);
    }
    for (const r of workflowRuns) {
      const path = r.sessionId ? sessionIdToPath.get(r.sessionId) : undefined;
      if (!path) continue;
      if (r.status === "pending" || r.status === "running") markRunning(path);
      else if (r.status === "paused" && ensure(path).agentStatus === "done") ensure(path).agentStatus = "needs-input";
    }
    return map;
  }, [groups, activeSessionPath, status.sessionPath, state.streaming, agentState, activity, workflowRuns]);
  const isLive = isAgentLive({
    streaming: state.streaming,
    // Host truth from the last hydrate: after a reload mid-turn the fresh
    // transcript state reports idle while the agent is still running.
    hostStreaming: agentState?.isStreaming === true,
    liveActivityCount,
    runningWorkflows,
  });
  const contextOpen = showWorkflowsPanel || showBranchPanel;
  const headerGit = status.cwd ? gitStatuses[status.cwd] ?? null : null;
  const headerBranch = (headerGit as any)?.branch ?? null;
  const headerCwdLine = status.cwd ? (headerBranch ? `${shortCwd(status.cwd)} (${headerBranch})` : shortCwd(status.cwd)) : null;
  const activeDirtyCount = (headerGit as any)?.isRepo ? ((headerGit as any).dirty?.length ?? 0) : 0;
  // One identity chip covers the old bot pill + room pill + Project button.
  const identityName = activeGroup?.name ?? activeBot?.name ?? projectSettings?.settings.defaultBot.name ?? null;
  const identityKind = activeGroup ? "room" : activeBot ? "bot" : null;
  const unresolvedAttention = listAttention(attention).length;

  // Diagnostics snapshot, recomputed only when an input to it actually
  // changes, not on every unrelated render while the panel is open. The
  // background policy input is a constant in this build, so it varies never.
  const diagnosticsSnapshot = useMemo(
    () =>
      Effect.runSync(
        collectDiagnosticsEffect({
          now: Date.now(),
          attention,
          policy: Effect.runSync(defaultPolicyEffect),
          events: eventLog,
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showDiagnostics, attention, eventLog]
  );

  // Preload/bridge missing (e.g. renderer opened outside Electron, or the
  // preload script failed to load). Previously `window.pideck` was accessed
  // unconditionally, every effect threw, React unmounted the tree, and the
  // window went blank, no UI, no error. Render a visible screen instead.
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
    {settingsOpen ? (
      <SettingsPage
        models={models}
        thinkingLevels={thinkingLevels}
        agentState={agentState}
        onSetModel={setModel}
        onSetThinking={setThinking}
        theme={themePref}
        themeId={themeId}
        onThemeIdChange={setThemeId}
        onThemeChange={setThemePref}
        onClose={() => setSettingsOpen(false)}
        bots={sharedStaff ?? bots}
        defaultBotName={projectSettings?.settings.defaultBot.name ?? null}
        botsEmptyHint={projectSettings ? "No staff yet." : undefined}
        onOpenBot={(bot) => {
          setSettingsOpen(false);
          void openBot(bot);
        }}
        onManageBots={() => setShowBots(true)}
        onOpenProject={() => void openProject()}
      />
    ) : null}
      {showProject && projectSettings && status.cwd ? (
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
      ) : null}
      {showBots ? (
        <BotsPanel
          bots={bots}
          activeBotId={activeBot?.id ?? null}
          onOpen={(bot) => void openBot(bot)}
          onCreate={createBot}
          onUpdate={updateBot}
          onDelete={deleteBot}
          defaultBot={appDefaultBot}
          onSaveDefaultBot={async (input) => {
            setAppDefaultBot(await bridge.botsDefaultSet(input));
          }}
          onClose={() => setShowBots(false)}
          groups={botGroups}
          activeGroupId={activeGroup?.id ?? null}
          onOpenGroup={(group) => void openGroup(group)}
          onCreateGroup={createGroup}
          onUpdateGroup={updateGroup}
          onDeleteGroup={deleteGroup}
          onSendMessage={sendBotMessage}
        />
      ) : null}
      <Sidebar
        groups={groups}
        activePath={activeSessionPath ?? status.sessionPath}
        activeCwd={status.cwd}
        treeOpen={showBranchPanel}
        canOpenTree={ready && hasSession}
        minimized={sidebarMinimized}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleMinimize={() =>
          setSidebarMinimized((minimized) => {
            localStorage.setItem("babylon:sidebar-minimized", minimized ? "0" : "1");
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
          if (!(await confirmAction({ title: `Delete chat "${name}"?`, message: "This cannot be undone.", confirmLabel: "Delete chat", danger: true }))) return;
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
        onSearch={() => togglePalette(true)}
        pinnedOrder={pinnedOrder}
        snoozed={snoozed}
        archived={archived}
        unread={unread}
        showArchived={showArchived}
        activeStreaming={hasSession && state.streaming}
        agentState={liveAgentState}
        sessionStatus={sessionStatusMap}
        activeBranch={activeBranch}
        gitStatuses={gitStatuses}
        onRefreshGitStatus={refreshGitStatusForCwd}
        agents={agentDockItems}
        onOpenAgent={(a) => void openAgentItem(a)}
        onStopAgent={(a) => void controlLaunch(a.id, a.kind, "stop")}
        spaceCwds={spaces}
        onAddSpace={() => void addSpace()}
        onRemoveSpace={removeSpace}
        openTabs={openTabs}
        onCloseTab={closeTab}
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
          <header className={`thread-header titlebar shrink-0 z-10 flex h-11 items-center gap-2 border-b border-line bg-bg ${sidebarMinimized ? "pl-[88px] pr-3" : "px-3"}`}>
            {sidebarMinimized ? (
              <button
                onClick={() => {
                  localStorage.setItem("babylon:sidebar-minimized", "0");
                  setSidebarMinimized(false);
                }}
                title="Show sidebar (⌘B)"
                aria-label="Show sidebar"
                className="sidebar-expand shrink-0"
              >
                <ChevronIcon size={16} strokeWidth={2} />
              </button>
            ) : null}
            {sidebarMinimized && spaces.length > 1 ? (
              <div className="w-[180px] shrink-0">
                <ProjectFilter
                  projects={spaces.map((c) => ({ cwd: c, name: c.split("/").filter(Boolean).pop() || c }))}
                  value={projectFilter}
                  onChange={setProjectFilter}
                />
              </div>
            ) : null}
            {promotedParent ? <button onClick={() => { const parent = promotedParent; setPromotedParent(null); void openSession(parent.path, parent.cwd); }} title="Back to parent session" className="thread-action thread-action-text">← Parent</button> : null}
            <StatusDot status={liveReady ? "ready" : status.status} working={isLive} />
            <div className="header-title min-w-0 max-w-[40ch] truncate text-[13px] font-semibold tracking-[-0.01em]" title={headerCwdLine ?? undefined}>
              {headerName ?? agentState?.sessionName ?? (hasSession ? "Untitled session" : "Babylon")}
            </div>
            {status.cwd ? (
              <button
                type="button"
                onClick={() => void openProject()}
                title={activeGroup ? `${activeGroup.name}'s room, members take serial turns here` : activeBot ? `${activeBot.name}'s forever-chat, reopening it resumes this same session` : "Project settings, default bot, team, free discussion"}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-raised px-2 py-0.5 text-[12px] font-semibold"
              >
                {identityName ? (
                  <>
                    <BotAvatar name={identityName} size={14} />
                    <span className="max-w-[14ch] truncate">{identityName}</span>
                    {identityKind ? <span className="text-dim">{identityKind}</span> : null}
                  </>
                ) : (
                  <span>Project</span>
                )}
              </button>
            ) : null}
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
                  {liveActivityCount > 0 ? <span className="absolute -right-1 -top-1 min-w-[16px] h-[16px] px-1 grid place-items-center rounded-full bg-accent text-white text-[10px] font-bold leading-none">{liveActivityCount}</span> : null}
                </button>
              ) : null}

              <button
                onClick={() => setShowAttention((v) => !v)}
                title={`Attention, ${unresolvedAttention} unresolved`}
                aria-pressed={showAttention}
                className={`thread-action relative ${showAttention ? "is-active" : ""}`}
              >
                <BellIcon size={14} className={unresolvedAttention > 0 ? "text-err" : ""} />
                {unresolvedAttention > 0 ? <span className="absolute -right-1 -top-1 min-w-[16px] h-[16px] px-1 grid place-items-center rounded-full bg-err text-white text-[10px] font-bold leading-none">{unresolvedAttention}</span> : null}
              </button>
              <button
                onClick={() => setShowCommitPopover(true)}
                title="Commit and push, stages all changes, generates a message, and pushes"
                className="thread-action thread-action-text text-[12px]"
              >
                Commit{activeDirtyCount > 0 ? ` ${activeDirtyCount}` : ""}
              </button>
              <PanelsMenu
                open={panelsMenuOpen}
                onOpenChange={setPanelsMenuOpen}
                items={[
                  { label: "Browser preview", open: showPreview, onToggle: () => setShowPreview((v) => !v) },
                  { label: "Runtime diagnostics", open: showDiagnostics, onToggle: () => setShowDiagnostics((v) => !v) },
                ]}
              />
              <button onClick={() => togglePalette(true)} title="Search and commands (⌘K)" className="thread-action">
                <FolderIcon size={16} />
              </button>
            </div>
            {preparingVisible ? <span className="shrink-0 text-[13px] text-dim">Preparing…</span> : null}
          </header>

          <div className="flex flex-1 min-h-0 flex-col">
              {hasSession ? (
                <ChatView
                  items={state.items}
                  renderCount={renderCap}
                  canLoadMore={canLoadMore}
                  loadingEarlier={loadingEarlier}
                  onNeedEarlier={() => void loadEarlier()}
                  streaming={isLive}
                  isRoom={activeGroup != null}
                  roomHandle={
                    activeGroup != null || sharedSpeakers
                      ? state.roomTurn?.phase === "started"
                        ? state.roomTurn.handle
                        : null
                      : null
                  }
                  roomMembers={
                    activeGroup
                      ? bots.filter((b) => activeGroup.memberIds.includes(b.id))
                      : sharedSpeakers
                        ? (sharedStaff ?? [])
                        : []
                  }
                  roomName={activeGroup?.name ?? ""}
                  showSpeakers={sharedSpeakers}
                  historyTurns={history.turns}
                  onRollback={(entryId) => void prepareRollback(entryId)}
                  onOpenLaunch={() => setShowWorkflowsPanel(true)}
                  onControlLaunch={(runId, runKind, action) => void controlLaunch(runId, runKind, action)}
                />
              ) : (
                <div className="flex flex-1 min-h-0 overflow-hidden">
                  <Hero status={status} groups={groups} onOpen={(path, cwd) => { setPromotedParent(null); void openSession(path, cwd); }} onNew={newSession} />
                </div>
              )}

            {hasSession ? (
              <SessionFooter
                agentState={agentState}
                stats={stats}
                models={models}
                thinkingLevels={thinkingLevels}
                onSetModel={setModel}
                onSetThinking={setThinking}
                onCompact={compact}
                streaming={isLive}
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
            onClose={() => togglePalette(false)}
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
      <Suspense fallback={null}>
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

function PanelsMenu({ open, onOpenChange, items }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  items: Array<{ label: string; open?: boolean; onToggle?(): void; badge?: number; action?(): void }>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onOpenChange(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => onOpenChange(!open)}
        title="More panels"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`thread-action ${open ? "is-active" : ""}`}
      >
        <MoreIcon size={16} />
      </button>
      {open && (
        <div role="menu" aria-label="Panels" className="thread-menu absolute right-0 top-full z-50 mt-2 min-w-[200px]">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitemcheckbox"
              aria-checked={item.open ?? false}
              onClick={() => {
                if (item.action) item.action();
                else item.onToggle?.();
              }}
              className="thread-menu-item"
            >
              <span>{item.label}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {item.badge ? <span className="sidebar-count">{item.badge}</span> : null}
                {item.open ? <span className="text-accent">✓</span> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
