import type {
  AttentionState,
  ExecutionState,
  SessionRuntimeState,
} from "../sessionRuntime";
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

/** Remove a tab; the session itself is untouched. Returns tabs + fallback. */
export function closeNavTab(
  tabs: NavTab[],
  path: string
): { tabs: NavTab[]; fallback: NavTab | null } {
  const index = tabs.findIndex((t) => t.path === path);
  if (index === -1) return { tabs, fallback: null };
  const next = tabs.filter((t) => t.path !== path);
  const fallback = next[Math.min(index, next.length - 1)] ?? null;
  return { tabs: next, fallback };
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

export type AgentSortState = "approval" | "working" | "waiting" | "failed" | "unread" | "live";

export interface LiveAgent {
  path: string;
  cwd: string;
  execution: ExecutionState;
  attention: AttentionState;
  startedAt?: number;
  mtime: number;
}

/**
 * Sessions with a chat that is actively running: a turn is in flight
 * (working), or the agent is mid-turn but blocked on the user (waiting,
 * approval). Idle chats, unread-only chats, and finished chats do NOT appear
 * here — this section is "running chats", not an inbox or a history. Pure
 * derivation from existing runtime + session metadata.
 */
export function deriveLiveAgents(
  runtime: SessionRuntimeState[],
  mtimeByPath: Map<string, number>
): LiveAgent[] {
  const out: LiveAgent[] = [];
  for (const r of runtime) {
    const running = r.execution === "working" || r.execution === "waiting" || r.execution === "approval";
    if (!running) continue;
    out.push({
      path: r.sessionPath,
      cwd: r.cwd,
      execution: r.execution,
      attention: r.attention,
      startedAt: r.startedAt,
      mtime: mtimeByPath.get(r.sessionPath) ?? 0,
    });
  }
  const rank = (a: LiveAgent): number => {
    if (a.attention === "approval" || a.execution === "approval") return 0;
    if (a.execution === "working") return 1;
    if (a.execution === "waiting") return 2;
    if (a.execution === "failed") return 3;
    return 4;
  };
  return out.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);
}

export function agentStateLabel(a: Pick<LiveAgent, "execution" | "attention">): string {
  if (a.attention === "approval" || a.execution === "approval") return "Needs input";
  if (a.execution === "working") return "Working";
  if (a.execution === "waiting") return "Waiting";
  if (a.execution === "failed") return "Failed";
  if (a.attention === "unread") return "Unread";
  return "Live";
}
