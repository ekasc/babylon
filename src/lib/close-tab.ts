/**
 * Tab close = pure navigation (I5). One transition may: remove the nav tab,
 * repair activeBySpace (via closeSpaceTab), and — only when the closed tab
 * was the VIEWED one — navigate within the same Space (sibling → pinned →
 * landing). It never touches a runtime: no releaseSession, no
 * executionDeactivate/Activate, no openSession, no abort. Closing the
 * execution-owner tab is explicitly legal; execution lives in
 * executionsByCwd + the Agents surface, not in the tab strip.
 */
import { closeSpaceTab, type NavTabsBlob } from "./nav-model";
import type { ProjectExecution } from "../execution";

export interface CloseTabDeps {
  navTabs: NavTabsBlob;
  setNavTabs(next: NavTabsBlob): void;
  viewedPathRef: { current: string | null };
  /** Session metadata for same-Space pinned fallback (cwd lookup only). */
  sessionByPath: ReadonlyMap<string, { cwd: string }>;
  pinnedOrder: string[];
  viewSession(path: string, cwd: string): unknown;
  showLanding(): void;
  /**
   * Test seams (I5): legacy runtime-lifetime surfaces and the execution
   * registry. Production close code must never call or mutate them — they
   * exist so the invariant is executable, not so anything uses them.
   */
  bridge?: {
    releaseSession?(...args: never[]): unknown;
    executionDeactivate?(...args: never[]): unknown;
    executionActivate?(...args: never[]): unknown;
    openSession?(...args: never[]): unknown;
    abort?(...args: never[]): unknown;
  };
  executionsByCwd?: Record<string, ProjectExecution>;
}

export interface CloseTabOutcome {
  removed: boolean;
  navigated: boolean;
}

export function performCloseTab(deps: CloseTabDeps, path: string): CloseTabOutcome {
  const wasSelected = deps.viewedPathRef.current === path;
  const { state, closed, fallback } = closeSpaceTab(deps.navTabs, path);
  if (!closed) return { removed: false, navigated: false };
  deps.setNavTabs(state);
  // Closing a non-selected tab is removal only: no view change, no epoch,
  // no unread clearing, no runtime operation.
  if (!wasSelected) return { removed: true, navigated: false };
  // Selected tab: navigate inside its own Space — open sibling, else a
  // same-Space pinned session, else landing (activeSpace is preserved by
  // showLanding; an execution for this Space may keep running throughout).
  if (fallback) {
    void deps.viewSession(fallback.path, fallback.cwd);
    return { removed: true, navigated: true };
  }
  const remaining = new Set(state.tabs.map((t) => t.path));
  const pinnedHere = deps.pinnedOrder.filter((p) => {
    const hit = deps.sessionByPath.get(p);
    return hit?.cwd === closed.cwd && p !== path && !remaining.has(p);
  });
  const pick = pinnedHere.length > 0 ? pinnedHere[pinnedHere.length - 1] : null;
  const meta = pick ? deps.sessionByPath.get(pick) : null;
  if (pick && meta) {
    void deps.viewSession(pick, meta.cwd);
    return { removed: true, navigated: true };
  }
  void deps.showLanding();
  return { removed: true, navigated: true };
}
