// Attention Inbox for Phase 5.
//
// One global place for everything that genuinely needs the user: permission
// requests, agent questions, failed/blocked tasks, merge conflicts, missing
// credentials, environment failures, and review requests. Items disappear when
// resolved. The model is pure and testable; the UI and cross-session wiring
// build on top.

export type AttentionType =
  | "permission"
  | "question"
  | "failed_task"
  | "blocked_task"
  | "merge_conflict"
  | "missing_credential"
  | "environment_failure"
  | "review_requested";

export interface AttentionItem {
  id: string;
  type: AttentionType;
  title: string;
  detail?: string;
  /** Originating session/agent, so the user can jump to context. */
  source?: string;
  createdAt: number;
  resolved: boolean;
}

export interface AttentionRegistry {
  items: Record<string, AttentionItem>;
}

export function createAttentionRegistry(): AttentionRegistry {
  return { items: {} };
}

export function addAttention(
  registry: AttentionRegistry,
  item: AttentionItem
): AttentionRegistry {
  // Do not clobber an existing item with the same id.
  if (registry.items[item.id]) return registry;
  return { items: { ...registry.items, [item.id]: item } };
}

export function resolveAttention(registry: AttentionRegistry, id: string): AttentionRegistry {
  const existing = registry.items[id];
  if (!existing || existing.resolved) return registry;
  return { items: { ...registry.items, [id]: { ...existing, resolved: true } } };
}

export function removeAttention(registry: AttentionRegistry, id: string): AttentionRegistry {
  if (!registry.items[id]) return registry;
  const next = { ...registry.items };
  delete next[id];
  return { items: next };
}

/** Unresolved items first, newest first. */
export function listAttention(registry: AttentionRegistry): AttentionItem[] {
  return Object.values(registry.items)
    .filter((i) => !i.resolved)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function listBySource(registry: AttentionRegistry, source: string): AttentionItem[] {
  return Object.values(registry.items).filter((i) => i.source === source && !i.resolved);
}
