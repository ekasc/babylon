import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

/**
 * t3code-style sidebar state (client-persisted): pinned order, snoozed
 * (path -> wake timestamp), archived, unread, and explicit settlement.
 */
export function useSidebarState() {
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
  // Explicit settlement (path -> settled timestamp), persisted. Settled means
  // finished/closed for now but first-class: restorable via Un-settle. Never
  // inferred; only set/unset here.
  const [settled, setSettled] = useState<Record<string, number>>(() =>
    JSON.parse(localStorage.getItem("babylon:settled") ?? "{}")
  );

  const toggleStringArray =
    (key: string, setter: Dispatch<SetStateAction<string[]>>) => (path: string) =>
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
  const markUnread = useCallback((path: string) => {
    setUnread((prev) => {
      if (prev.includes(path)) return prev;
      const next = [...prev, path];
      localStorage.setItem("babylon:unread", JSON.stringify(next));
      return next;
    });
  }, []);
  const clearUnread = useCallback((path: string) => {
    setUnread((prev) => {
      if (!prev.includes(path)) return prev;
      const next = prev.filter((p) => p !== path);
      localStorage.setItem("babylon:unread", JSON.stringify(next));
      return next;
    });
  }, []);
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
