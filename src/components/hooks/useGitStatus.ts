import { useCallback, useEffect, useState } from "react";
import { bridge, type GitStatusResult, type ProjectGroup } from "../../bridge";

export function useGitStatus(projects: ProjectGroup[]) {
  const [gitStatuses, setGitStatuses] = useState<Record<string, GitStatusResult>>({});

  // Git status keyed by project cwd, so every thread can show its
  // branch (and full status on hover). Refreshed when the session list or
  // active project changes, on a light timer, and on row hover.
  const refreshGitStatuses = useCallback(() => {
    const cwds = Array.from(new Set(projects.map((g) => g.cwd).filter(Boolean))) as string[];
    if (!cwds.length) return;
    Promise.all(
      cwds.map((c) => bridge.gitStatus(c).then((s) => [c, s] as const).catch(() => [c, null] as const))
    )
      .then((results) => {
        setGitStatuses((prev) => {
          const next = { ...prev };
          for (const [c, s] of results) if (s) next[c] = s;
          return next;
        });
      })
      .catch(() => undefined);
  }, [projects]);

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
