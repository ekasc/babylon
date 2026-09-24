import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge, type GitStatusResult, type ProjectGroup } from "../../bridge";

export function useGitStatus(projects: ProjectGroup[]) {
  const [gitStatuses, setGitStatuses] = useState<Record<string, GitStatusResult>>({});

  // Stable key over the SET of cwds. `groups` gets a fresh array identity on
  // every session-index emission (fs.watch fires constantly while an agent is
  // streaming), so depending on `projects` directly re-ran a full
  // one-git-per-project spawn burst per emission. The key only changes when
  // projects actually come or go.
  const cwdKey = useMemo(() => {
    const cwds = Array.from(new Set(projects.map((g) => g.cwd).filter(Boolean))) as string[];
    cwds.sort();
    return cwds.join("\n");
  }, [projects]);

  // Guards overlapping full refreshes: a timer tick landing mid-refresh (or a
  // cwd change racing one) shares the in-flight pass instead of stacking a
  // second burst of spawns.
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshGitStatuses = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const cwds = cwdKey.length ? cwdKey.split("\n") : [];
    if (!cwds.length) return Promise.resolve();
    const run: Promise<void> = Promise.all(
      cwds.map((c) => bridge.gitStatus(c).then((s) => [c, s] as const).catch(() => [c, null] as const))
    )
      .then((results) => {
        setGitStatuses((prev) => {
          const next = { ...prev };
          for (const [c, s] of results) if (s) next[c] = s;
          return next;
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (refreshInFlight.current === run) refreshInFlight.current = null;
      });
    refreshInFlight.current = run;
    return run;
  }, [cwdKey]);

  const refreshGitStatusForCwd = useCallback((cwd: string) => {
    bridge.gitStatus(cwd).then((s) => { if (s) setGitStatuses((prev) => ({ ...prev, [cwd]: s })); }).catch(() => {});
  }, []);

  useEffect(() => { refreshGitStatuses(); }, [refreshGitStatuses]);
  useEffect(() => {
    const id = window.setInterval(refreshGitStatuses, 30_000);
    return () => window.clearInterval(id);
  }, [refreshGitStatuses]);

  return { gitStatuses, refreshGitStatuses, refreshGitStatusForCwd };
}
