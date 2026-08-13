import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { bridge, bridgeAvailable, type ActivityUpdate, type CommandInfo, type HistoryProjection, type ProjectGroup, type RollbackPlan, type SessionStatus, type WorkflowRunSummary } from "./bridge";
import { initialState, reducer } from "./store";
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
import { FlaskIcon, FolderIcon, MoreIcon, PiMark } from "./components/icons";

const BranchPanel = lazy(() => import("./components/BranchPanel"));
const WorkflowsPanel = lazy(() => import("./components/WorkflowsPanel"));
const CommandPalette = lazy(() => import("./components/CommandPalette"));

function shortPath(cwd?: string): string {
  if (!cwd) return "Babylon";
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}

function StatusDot({ status }: { status: string }) {
  const cls =
    status === "ready"
      ? "bg-ok"
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
  const [status, setStatus] = useState<SessionStatus>({ status: "idle" });
  const [models, setModels] = useState<any[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [agentState, setAgentState] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [worktreeInfo, setWorktreeInfo] = useState<WorktreeInfo | null>(null);
  const [showWorktreeModal, setShowWorktreeModal] = useState(false);
  const [showBranchPanel, setShowBranchPanel] = useState(false);
  const [showWorkflowsPanel, setShowWorkflowsPanel] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [history, setHistory] = useState<HistoryProjection>({ turns: [], leafId: null, hasBranches: false });
  const [historyRevision, setHistoryRevision] = useState(0);
  const [rollbackPlan, setRollbackPlan] = useState<RollbackPlan | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [contextWidth, setContextWidth] = useState(() => {
    const stored = Number(localStorage.getItem("pideck:context-width"));
    return Number.isFinite(stored) && stored >= 360 && stored <= 760 ? stored : 520;
  });
  const [draftRequest, setDraftRequest] = useState<{ id: number; text: string } | null>(null);
  const [promotedParent, setPromotedParent] = useState<{ path: string; cwd: string } | null>(null);
  const [activity, setActivity] = useState<ActivityUpdate>({ threads: [], subagents: [] });
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSummary[]>([]);
  const [wtBusy, setWtBusy] = useState(false);
  // `hasSession` = a session's content is on screen (preview or live).
  // `liveReady` = the pi process is live on that session. Opening a session
  // flips hasSession immediately (instant file preview); liveReady follows
  // once the in-process switch completes — no Hero flash, no blocking.
  const [hasSession, setHasSession] = useState(false);
  const [liveReady, setLiveReady] = useState(false);
  // The epoch of the session currently on screen. Agent events are tagged with
  // the epoch captured when they start; events from a stale (previous) session
  // are dropped so streams can't bleed into a freshly-opened transcript.
  const epochRef = useRef(0);
  const latestRequestRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const switchingRef = useRef(false);
  const liveReadyRef = useRef(false);
  const activePathRef = useRef<string | null>(null);
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
        for (const event of events) {
          if (shouldAcceptEvent(event, context)) dispatch({ type: "event", event });
        }
      }),
    []
  );

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
      dispatch({ type: "rebuild", messages: msgs });
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
        dispatch({ type: "rebuild", messages: msgs });
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

  const openSession = useCallback(
    async (path: string | undefined, cwd: string) => {
      const expectedEpoch = ++epochRef.current;
      const requestId = ++latestRequestRef.current;
      switchingRef.current = true;
      liveReadyRef.current = false;
      activeSessionIdRef.current = null;
      activePathRef.current = path ?? null;
      // Fetch the stored transcript FIRST so the UI never renders an empty
      // chat while we switch — `reset` + `rebuild` batch into one render with
      // the messages already populated (no empty-state flicker).
      let cached: any[] | undefined;
      if (path) {
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
      setAgentState(null);
      setModels([]);
      setCommands([]);
      setWorktreeInfo(null);
      setHistory({ turns: [], leafId: null, hasBranches: false });
      rollbackDraftRef.current = null;
      setRollbackPlan(null);
      dispatch({ type: "reset" });
      if (cached) dispatch({ type: "rebuild", messages: cached });
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

  const newSession = useCallback(async () => {
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
  const bannerVisible = hasSession && liveReady && !!worktreeInfo?.isWorktree;
  const liveActivityCount =
    workflowRuns.filter((run) => run.status === "pending" || run.status === "running" || run.status === "paused").length +
    activity.threads.filter((thread) => ["queued", "starting", "running", "interrupting"].includes(thread.status)).length +
    activity.subagents.filter((run) => run.status === "running").length;
  const contextOpen = showWorkflowsPanel || showBranchPanel;

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
        activePath={status.sessionPath}
        activeCwd={status.cwd}
        activityCount={liveActivityCount}
        activityOpen={showWorkflowsPanel}
        treeOpen={showBranchPanel}
        canOpenTree={ready && hasSession}
        onOpen={(path, cwd) => {
          setPromotedParent(null);
          void openSession(path, cwd);
        }}
        onNew={newSession}
        onOpenActivity={() => {
          setShowWorkflowsPanel((open) => !open);
          setShowBranchPanel(false);
        }}
        onOpenTree={() => {
          if (!ready || !hasSession) return;
          setShowBranchPanel((open) => !open);
          setShowWorkflowsPanel(false);
        }}
        onSearch={() => setShowCommandPalette(true)}
      />

      <div className="flex min-w-0 flex-1">
        <main className="primary-workspace relative min-w-0 flex-1">
          <div className="absolute inset-0">
            {hasSession ? (
              <ChatView
                items={state.items}
                streaming={state.streaming}
                chromeTop={bannerVisible ? 104 : 66}
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
            <StatusDot status={liveReady ? "ready" : status.status} />
            <div className="min-w-0 flex items-baseline gap-2.5">
              <div className="truncate text-[15px] font-semibold tracking-[-0.01em]">
                {agentState?.sessionName ?? (hasSession ? "Untitled session" : "Babylon")}
              </div>
              <div className="truncate text-[13px] text-dim">
                {hasSession && status.cwd ? shortPath(status.cwd) : "Choose a project to begin"}
              </div>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {hasSession && worktreeInfo?.isWorktree ? <span className="execution-context"><FlaskIcon size={13} /> Worktree</span> : hasSession ? <span className="execution-context">Local</span> : null}
              {hasSession ? (
                <button onClick={() => setShowWorktreeModal(true)} title="Session and worktree actions" className="thread-action">
                  <MoreIcon size={16} />
                </button>
              ) : null}
              <button onClick={() => setShowCommandPalette(true)} title="Search and commands (⌘K)" className="thread-action">
                <FolderIcon size={16} />
              </button>
            </div>
            {hasSession && !liveReady ? <span className="shrink-0 text-[13px] text-dim">Preparing…</span> : null}
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
