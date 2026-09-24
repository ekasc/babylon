import { useCallback, useState } from "react";
import { getWithFallback, setWithFallback } from "../../lib/storage";

/**
 * Local UI panels and chrome toggles. Pure visibility state (nothing here
 * drives data); the two persisted chrome prefs write through on change.
 * All setters keep stable identity for memoized consumers.
 */
export function usePanels() {
  const [showCommitPopover, setShowCommitPopover] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);
  const [showProject, setShowProject] = useState(false);
  const [sidebarMinimized, setSidebarMinimizedState] = useState(
    () => getWithFallback("sidebar-minimized") === "1"
  );
  const [sideOpen, setSideOpenState] = useState(() => getWithFallback("session-sidebar") === "1");

  const setSidebarMinimized = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    // Write-through updater (the shape App used inline): idempotent, so
    // StrictMode double-invocation only rewrites the same value.
    setSidebarMinimizedState((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      setWithFallback("sidebar-minimized", resolved ? "1" : "0");
      return resolved;
    });
  }, []);

  const setSideOpen = useCallback((next: boolean) => {
    setWithFallback("session-sidebar", next ? "1" : "0");
    setSideOpenState(next);
  }, []);

  return {
    showCommitPopover,
    setShowCommitPopover,
    showCommandPalette,
    setShowCommandPalette,
    settingsOpen,
    setSettingsOpen,
    showNewSession,
    setShowNewSession,
    showProject,
    setShowProject,
    sidebarMinimized,
    setSidebarMinimized,
    sideOpen,
    setSideOpen,
  };
}
