import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { defineStore, useVersionedState } from "../../lib/versioned-store";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string");
}

function isPathMap(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry): entry is number => typeof entry === "number" && Number.isFinite(entry)
  );
}

const pinnedStore = defineStore<string[]>({
  key: "pinned",
  version: 1,
  fallback: () => [],
  validate: isStringArray,
});

const snoozedStore = defineStore<Record<string, number>>({
  key: "snoozed",
  version: 1,
  fallback: () => ({}),
  validate: isPathMap,
});

const archivedStore = defineStore<string[]>({
  key: "archived",
  version: 1,
  fallback: () => [],
  validate: isStringArray,
});

const unreadStore = defineStore<string[]>({
  key: "unread",
  version: 1,
  fallback: () => [],
  validate: isStringArray,
});

const settledStore = defineStore<Record<string, number>>({
  key: "settled",
  version: 1,
  fallback: () => ({}),
  validate: isPathMap,
});

/**
 * t3code-style sidebar state (client-persisted): pinned order, snoozed
 * (path -> wake timestamp), archived, unread, and explicit settlement.
 */
export function useSidebarState() {
  const [pinnedOrder, setPinnedOrder] = useVersionedState(pinnedStore);
  const [snoozed, setSnoozed] = useVersionedState(snoozedStore);
  const [archived, setArchived] = useVersionedState(archivedStore);
  const [unread, setUnread] = useVersionedState(unreadStore);
  const [showArchived, setShowArchived] = useState(false);
  // Explicit settlement (path -> settled timestamp), persisted. Settled means
  // finished/closed for now but first-class: restorable via Un-settle. Never
  // inferred; only set/unset here.
  const [settled, setSettled] = useVersionedState(settledStore);

  const toggleStringArray =
    (setter: Dispatch<SetStateAction<string[]>>) => (path: string) =>
      setter((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
  const togglePin = useCallback((path: string) => {
    setPinnedOrder((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
  }, []);

  const toggleSnooze = useCallback((path: string, until?: number) => {
    setSnoozed((prev) => {
      const next = { ...prev };
      if (until == null || Number.isNaN(until)) delete next[path];
      else next[path] = until;
      return next;
    });
  }, []);
  const toggleUnread = useCallback(toggleStringArray(setUnread), []);
  const markUnread = useCallback((path: string) => {
    setUnread((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }, []);
  const clearUnread = useCallback((path: string) => {
    setUnread((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : prev));
  }, []);
  const toggleArchive = useCallback(
    (path: string) => {
      setArchived((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
      // Archiving also drops the pin so it doesn't linger in the Pinned section.
      setPinnedOrder((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : prev));
    },
    []
  );
  const toggleShowArchived = useCallback(() => setShowArchived((v) => !v), []);

  return {
    pinnedOrder,
    setPinnedOrder,
    snoozed,
    setSnoozed,
    archived,
    setArchived,
    unread,
    setUnread,
    setSettled,
    showArchived,
    setShowArchived,
    settled,
    togglePin,
    toggleSnooze,
    toggleUnread,
    markUnread,
    clearUnread,
    toggleArchive,
    toggleShowArchived,
  };
}
