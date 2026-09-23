/**
 * View/execution split (src/execution.ts invariants I2/I3): disk-only
 * session navigation. `viewSession` is what ordinary navigation does —
 * select transcript, load stored messages, register the tab — and never
 * touches Pi activation, execution ownership, or runtime lifetime.
 *
 * The activation path (PiHost open) stays a separate caller
 * (App.openSession delegates its view half here, then activates).
 */
import type { Bridge, CommandInfo, SessionWindow } from "../bridge";
import type { ProjectExecution } from "../execution";
import { isSessionNotFound } from "./errors";

export type ViewSessionStatus = "committed" | "stale" | "missing" | "failed";

export interface ViewSessionOutcome {
  status: ViewSessionStatus;
  /** Restore the pre-view transcript + identity. Meaningful only after
   *  `status === "committed"`: activation failed after a successful disk
   *  view, so the caller rolls the view back to what was on screen. */
  rollback(): void;
}

export interface SessionCacheEntry {
  messages: unknown[];
  earliestOffset: number | null;
  canLoadMore: boolean;
}

export interface ViewNavigationDeps {
  // View identity.
  epochRef: { current: number };
  viewedPathRef: { current: string | null };
  activeCwdRef: { current: string | null };
  activeSessionIdRef: { current: string | null };
  liveReadyRef: { current: boolean };
  hasSessionRef: { current: boolean };
  setViewedSessionPath(path: string | null): void;
  setHasSession(v: boolean): void;
  setLiveReady(v: boolean): void;
  setStats(v: null): void;
  setCommands(v: CommandInfo[]): void;
  resetHistory(): void;
  setCanLoadMore(v: boolean): void;
  rollbackDraftRef: { current: string | null };
  setRollbackPlan(v: null): void;
  // Transcript buffers.
  loadedMessagesRef: { current: unknown[] };
  earliestOffsetRef: { current: number | null };
  sessionCacheRef: { current: Map<string, SessionCacheEntry> };
  resetTranscript(): void;
  rebuildTranscript(messages: unknown[]): void;
  // Navigation side effects.
  clearUnread(path: string): void;
  clearArmings(): void;
  /** Register/select the open tab and adopt its Space (view-side). */
  registerTab(cwd: string, path: string): void;
  claimSwitch(): number;
  releaseSwitch(token: number): void;
  /** Evict a vanished session's tab and refresh the index. */
  evictDeadTab(path: string): void;
  /** Project home (used by the quietMissing fallback). */
  showLanding(): void;
  toast(type: "info" | "warning" | "error", message: string): void;
  bridge: Pick<Bridge, "getSessionMessages">;
}

type Win = SessionWindow;

/**
 * Disk-only view navigation. Returns an outcome so callers can distinguish
 * a committed view (activation may proceed) from stale/missing/failed loads.
 * Never calls openSession / executionActivate / releaseSession (I3).
 */
export async function viewSession(
  /** Session to view; null only for the activation path creating a fresh
   *  session (no transcript exists yet — identity lands null until ready). */
  path: string | null,
  cwd: string,
  deps: ViewNavigationDeps,
  opts?: { quietMissing?: boolean }
): Promise<ViewSessionOutcome> {
  const d = deps;
  const expectedEpoch = ++d.epochRef.current;
  // Composer intent (Goal/Design arming) is view-bound: a new view drops it.
  d.clearArmings();
  // You are looking at it now: unread clears. Lifecycle does not change —
  // settled sessions stay under Settled (I3).
  if (path) d.clearUnread(path);

  // Stash the current view so a failed switch can stay put instead of
  // stranding the user on Home.
  const prevPath = d.viewedPathRef.current;
  const prevMessages = d.loadedMessagesRef.current;
  const prevOffset = d.earliestOffsetRef.current;
  const prevCanLoadMore = prevOffset != null && prevOffset > 0;
  const rollback = (): void => {
    if (prevPath) {
      d.viewedPathRef.current = prevPath;
      d.setViewedSessionPath(prevPath);
      d.loadedMessagesRef.current = prevMessages;
      d.earliestOffsetRef.current = prevOffset;
      d.setCanLoadMore(prevCanLoadMore);
      if (prevMessages.length) d.rebuildTranscript(prevMessages);
    } else {
      d.hasSessionRef.current = false;
      d.setHasSession(false);
      d.liveReadyRef.current = false;
      d.setLiveReady(false);
    }
  };

  const token = d.claimSwitch();
  d.liveReadyRef.current = false;
  d.activeSessionIdRef.current = null;
  d.viewedPathRef.current = path;
  d.activeCwdRef.current = cwd;
  // Optimistic identity: the row highlights immediately; the old chat stays
  // visible until the new transcript is ready, then swaps in one frame.
  d.setViewedSessionPath(path);

  // Transcript cache (SESSION_CACHE): switching back renders from memory.
  const memo = path ? d.sessionCacheRef.current.get(path) : undefined;
  if (path && memo) {
    // Refresh LRU recency.
    d.sessionCacheRef.current.delete(path);
    d.sessionCacheRef.current.set(path, memo);
  }
  // Fetch the stored transcript tail FIRST so the UI never renders an empty
  // chat while we switch (`reset` + `rebuild` batch into one render).
  let cached: Win | undefined;
  if (path && !memo) {
    try {
      cached = await d.bridge.getSessionMessages(path);
    } catch (e) {
      if (isSessionNotFound(e)) {
        // Stale sidebar index or persisted tab: the transcript file is gone.
        // Evict every tab pointing at it, refresh the index, and land quiet
        // (speculative restore) or explain + restore the previous view.
        d.evictDeadTab(path);
        if (opts?.quietMissing) {
          d.releaseSwitch(token);
          d.showLanding();
          return { status: "missing", rollback };
        }
        d.toast("info", "That session file no longer exists — cleaned up its tab.");
        d.releaseSwitch(token);
        rollback();
        return { status: "missing", rollback };
      }
      d.toast("error", "failed to load session");
      d.releaseSwitch(token);
      rollback();
      return { status: "failed", rollback };
    }
  }
  if (expectedEpoch !== d.epochRef.current) {
    // A newer view superseded this one while the tail loaded: drop the
    // stale result entirely (test: rapid A→B→A, latest wins).
    d.releaseSwitch(token);
    return { status: "stale", rollback };
  }

  d.hasSessionRef.current = true;
  d.setHasSession(true);
  d.setLiveReady(false);
  d.setStats(null);
  // Models are project-scoped and cached separately; commands are cwd-bound
  // and reload per project. History/rollback views are session-shaped and
  // reset until an activation hydrates live truth.
  d.setCommands([]);
  d.resetHistory();
  d.rollbackDraftRef.current = null;
  d.setRollbackPlan(null);
  d.resetTranscript();
  if (memo) {
    d.rebuildTranscript(memo.messages);
  } else {
    d.loadedMessagesRef.current = cached?.messages ?? [];
    d.earliestOffsetRef.current = cached?.startOffset ?? null;
    d.setCanLoadMore(cached != null && cached.startOffset > 0);
    if (cached?.messages.length) d.rebuildTranscript(cached.messages);
  }
  // The view owns tab registration + Space adoption (I2: no runtime needed).
  // A fresh-session activation registers at ready instead (no file yet).
  if (path) d.registerTab(cwd, path);
  // No activation follows: release the switch claim here (the ready handler
  // would otherwise have to clear it for a ready that never comes).
  d.releaseSwitch(token);
  return { status: "committed", rollback };
}

export type ViewLandingDeps = Pick<
  ViewNavigationDeps,
  | "epochRef"
  | "viewedPathRef"
  | "activeSessionIdRef"
  | "liveReadyRef"
  | "hasSessionRef"
  | "setViewedSessionPath"
  | "setHasSession"
  | "setLiveReady"
  | "clearArmings"
>;

/**
 * Project home: viewed session = null, show project landing. Pure view
 * identity — deliberately does not read or write executionsByCwd (I3): an
 * execution can keep running while the landing page is visible.
 */
export function showViewLanding(deps: ViewLandingDeps): void {
  const d = deps;
  ++d.epochRef.current;
  d.activeSessionIdRef.current = null;
  d.liveReadyRef.current = false;
  d.viewedPathRef.current = null;
  d.setViewedSessionPath(null);
  d.hasSessionRef.current = false;
  d.setHasSession(false);
  d.setLiveReady(false);
  d.clearArmings();
}

/** Hydrate Record<cwd, ProjectExecution> from executionList(). */
export function indexExecutions(list: readonly ProjectExecution[]): Record<string, ProjectExecution> {
  return Object.fromEntries(list.map((execution) => [execution.cwd, execution]));
}

/**
 * Fold one execution_changed push into the registry. Stale events (a lower
 * generation than the stored record) never overwrite newer ownership.
 */
export function mergeExecution(
  prev: Record<string, ProjectExecution>,
  incoming: ProjectExecution
): Record<string, ProjectExecution> {
  const existing = prev[incoming.cwd];
  if (existing && existing.generation > incoming.generation) return prev;
  return { ...prev, [incoming.cwd]: incoming };
}
