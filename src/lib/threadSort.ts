export interface ThreadSortInput {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestUserMessageAt?: string | null;
  readonly messages?: ReadonlyArray<{
    readonly createdAt: string;
    readonly role: string;
  }>;
}

export function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getFirstSortableTimestamp(...values: Array<string | null | undefined>): number | null {
  for (const value of values) {
    const timestamp = toSortableTimestamp(value ?? undefined);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function getLatestUserMessageTimestamp(thread: ThreadSortInput): number {
  if (thread.latestUserMessageAt) {
    const ts = toSortableTimestamp(thread.latestUserMessageAt);
    if (ts !== null) return ts;
  }
  let latest: number | null = null;
  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const ts = toSortableTimestamp(message.createdAt);
    if (ts === null) continue;
    latest = latest === null ? ts : Math.max(latest, ts);
  }
  if (latest !== null) return latest;
  return getFirstSortableTimestamp(thread.updatedAt, thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function getThreadSortTimestamp(
  thread: ThreadSortInput,
  sortOrder: "latest" | "created_at",
): number {
  if (sortOrder === "created_at") {
    return getFirstSortableTimestamp(thread.createdAt, thread.updatedAt) ?? Number.NEGATIVE_INFINITY;
  }
  return getLatestUserMessageTimestamp(thread);
}

export function activeThreadAnchorTimestampMs(thread: {
  readonly createdAt: string;
  readonly unsettledAt?: string | null | undefined;
}): number {
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? 0,
    toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
  );
}

export function sortThreads<T extends { readonly id: string } & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: "latest" | "created_at" = "latest",
): T[] {
  return [...threads].sort((a, b) => {
    const ta = getThreadSortTimestamp(a, sortOrder);
    const tb = getThreadSortTimestamp(b, sortOrder);
    if (ta !== tb) return tb - ta;
    return b.id.localeCompare(a.id);
  });
}

export function getLatestThreadForProject<
  T extends {
    readonly id: string;
    readonly projectId: string;
    readonly archivedAt: string | null;
  } & ThreadSortInput,
>(threads: readonly T[], projectId: string): T | null {
  return sortThreads(threads.filter((t) => t.projectId === projectId && t.archivedAt === null), "latest")[0] ?? null;
}
