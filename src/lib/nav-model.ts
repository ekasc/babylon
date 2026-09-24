import { defineStore } from "./versioned-store";

/**
 * Pure nav-model helpers for the Spaces / Agents / Tabs IA.
 *
 * Space = persistent project context (a cwd).
 * Session = persistent conversation history (a path).
 * Agent = live runtime state attached to a session (derived, never stored).
 */

export interface NavTab {
  path: string;
  cwd: string;
}

export interface NavTabsBlob {
  tabs: NavTab[];
  /** Remembered VIEWED tab per Space (last open/selected session of that
   *  project) — never execution ownership. */
  activeBySpace: Record<string, string>;
}

/** Legacy per-space shape (`babylon:tabs` v1) → global ordered working set. */
export function migrateLegacyTabs(
  raw: unknown,
  spaceOrder: string[]
): NavTabsBlob {
  if (
    raw != null &&
    typeof raw === "object" &&
    Array.isArray((raw as NavTabsBlob).tabs)
  ) {
    const blob = raw as NavTabsBlob;
    return {
      tabs: blob.tabs.filter((t) => t && typeof t.path === "string" && typeof t.cwd === "string"),
      activeBySpace:
        blob.activeBySpace && typeof blob.activeBySpace === "object" ? blob.activeBySpace : {},
    };
  }
  const tabs: NavTab[] = [];
  if (raw != null && typeof raw === "object") {
    const order = [...spaceOrder];
    for (const cwd of Object.keys(raw as Record<string, unknown>)) {
      if (!order.includes(cwd)) order.push(cwd);
    }
    for (const cwd of order) {
      const list = (raw as Record<string, unknown>)[cwd];
      if (!Array.isArray(list)) continue;
      for (const path of list) {
        if (typeof path === "string" && !tabs.some((t) => t.path === path)) {
          tabs.push({ path, cwd });
        }
      }
    }
  }
  return { tabs, activeBySpace: {} };
}

function isNavTabsBlob(value: unknown): value is NavTabsBlob {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { tabs?: unknown; activeBySpace?: unknown };
  if (!Array.isArray(record.tabs)) return false;
  if (
    !record.tabs.every(
      (entry): entry is NavTab =>
        !!entry && typeof entry === "object" &&
        typeof (entry as { path?: unknown }).path === "string" &&
        typeof (entry as { cwd?: unknown }).cwd === "string"
    )
  ) {
    return false;
  }
  if (record.activeBySpace === null || typeof record.activeBySpace !== "object" || Array.isArray(record.activeBySpace)) {
    return false;
  }
  return Object.values(record.activeBySpace).every((path): path is string => typeof path === "string");
}

/** User-curated project spaces (plain cwd list). */
export const spacesStore = defineStore<string[]>({
  key: "spaces",
  version: 1,
  fallback: () => [],
  validate: (value): value is string[] =>
    Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string"),
});

/** Explicit project context; null on landing with no space selected. */
export const activeSpaceStore = defineStore<string | null>({
  key: "active-space",
  version: 1,
  fallback: () => null,
  validate: (value): value is string | null => value === null || typeof value === "string",
});

/** Versioned working-set store (v2 blob; v1 per-space records migrate). */
export const tabsStore = defineStore<NavTabsBlob>({
  key: "tabs",
  version: 2,
  fallback: () => ({ tabs: [], activeBySpace: {} }),
  validate: isNavTabsBlob,
  migrate: (value) => (isNavTabsBlob(value) ? value : migrateLegacyTabs(value, [])),
});

/** Insert a tab (no reorder on re-add); bounded working set. */
export function addNavTab(tabs: NavTab[], cwd: string, path: string, cap = 24): NavTab[] {
  if (tabs.some((t) => t.path === path)) return tabs;
  const next = [...tabs, { path, cwd }];
  while (next.length > cap) next.shift();
  return next;
}

export interface CloseTabResult {
  state: NavTabsBlob;
  closed: NavTab | null;
  fallback: NavTab | null;
}

/**
 * Remove a tab (session untouched) with SPACE-SCOPED fallback: among the
 * closed tab's own project tabs, prefer the right neighbor, else the left —
 * never a tab from another Space (global interleaving is preserved as
 * stored; only the fallback choice is project-local). Atomically repairs
 * activeBySpace when the remembered viewed tab of that Space was the one
 * closed (→ fallback, or the key is deleted). Other Spaces' entries are
 * byte-for-byte untouched.
 */
export function closeSpaceTab(state: NavTabsBlob, path: string): CloseTabResult {
  const closed = state.tabs.find((t) => t.path === path) ?? null;
  if (!closed) return { state, closed: null, fallback: null };
  const index = state.tabs.findIndex((t) => t.path === path);
  const tabs = state.tabs.filter((t) => t.path !== path);
  const right = state.tabs.slice(index + 1).find((t) => t.cwd === closed.cwd) ?? null;
  const left = state.tabs.slice(0, index).reverse().find((t) => t.cwd === closed.cwd) ?? null;
  const fallback = right ?? left;
  const activeBySpace = { ...state.activeBySpace };
  if (activeBySpace[closed.cwd] === closed.path) {
    if (fallback) activeBySpace[closed.cwd] = fallback.path;
    else delete activeBySpace[closed.cwd];
  }
  return { state: { tabs, activeBySpace }, closed, fallback };
}

export function pickSpaceTab(tabs: NavTab[], activeBySpace: Record<string, string>, cwd: string): NavTab | null {
  const remembered = activeBySpace[cwd];
  if (remembered) {
    const hit = tabs.find((t) => t.path === remembered && t.cwd === cwd);
    if (hit) return hit;
  }
  const open = tabs.filter((t) => t.cwd === cwd);
  return open[open.length - 1] ?? null;
}

/** Header tab strip shows one project's working set. With no project
 *  context (fresh boot, landing) everything shows so tabs never strand. */
export function visibleSpaceTabs<T extends NavTab>(tabs: T[], cwd: string | null): T[] {
  if (!cwd) return tabs;
  return tabs.filter((t) => t.cwd === cwd);
}

