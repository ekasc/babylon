import * as Effect from "effect/Effect";
import { getThreadSortTimestamp, sortThreads, toSortableTimestamp } from "./threadSort";
import type { ThreadSortInput } from "./threadSort";

export const toSortableTimestampEffect = (iso: string | undefined): Effect.Effect<number | null> =>
  Effect.sync(() => toSortableTimestamp(iso));

export const getThreadSortTimestampEffect = (
  thread: ThreadSortInput,
  sortOrder: "latest" | "created_at",
): Effect.Effect<number> => Effect.sync(() => getThreadSortTimestamp(thread, sortOrder));

export const sortThreadsEffect = <T extends { readonly id: string } & ThreadSortInput>(
  threads: readonly T[],
  sortOrder?: "latest" | "created_at",
): Effect.Effect<T[]> => Effect.sync(() => sortThreads(threads, sortOrder));
