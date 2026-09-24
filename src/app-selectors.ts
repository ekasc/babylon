import type { ProjectGroup, SessionMeta } from "./bridge";
import type { AttentionState, SessionRuntimeState } from "./sessionRuntime";
import type { HistoryEntry } from "./components/SessionHistoryMenu";

export type SessionByPath = Map<string, { session: SessionMeta; cwd: string }>;

export function buildSessionByPath(groups: ProjectGroup[]): SessionByPath {
  const map: SessionByPath = new Map();
  for (const g of groups) for (const s of g.sessions) map.set(s.path, { session: s, cwd: g.cwd });
  return map;
}

export function resolveSessionTitle(sessionByPath: SessionByPath, path: string): string {
  const hit = sessionByPath.get(path);
  if (!hit) return path.split("/").filter(Boolean).pop() ?? path;
  return hit.session.name ?? hit.session.firstUserText ?? hit.session.id.slice(0, 8);
}

export function buildTabItems(
  tabs: Array<{ path: string }>,
  sessionByPath: SessionByPath,
  titleFor: (path: string) => string
): Array<{ path: string; cwd: string; title: string }> {
  return tabs.flatMap((t) => {
    const hit = sessionByPath.get(t.path);
    if (!hit) return [];
    return [{ path: t.path, cwd: hit.cwd, title: titleFor(t.path) }];
  });
}

export function buildAttentionByPath(runtimeByPath: Record<string, SessionRuntimeState>): Map<string, AttentionState> {
  const map = new Map<string, AttentionState>();
  for (const [path, r] of Object.entries(runtimeByPath)) map.set(path, r.attention);
  return map;
}

export function buildHistoryEntries(groups: ProjectGroup[], openPaths: Set<string>): HistoryEntry[] {
  const all: HistoryEntry[] = [];
  for (const g of groups) {
    for (const s of g.sessions) {
      all.push({
        path: s.path,
        cwd: s.cwd,
        title: s.name ?? s.firstUserText ?? s.id.slice(0, 8),
        projectName: g.cwd.split("/").filter(Boolean).pop() || g.cwd,
        mtime: s.mtime,
        open: openPaths.has(s.path),
      });
    }
  }
  return all.sort((a, b) => b.mtime - a.mtime).slice(0, 15);
}


export function buildAllSpaceCwds(spaces: string[], activeSpace: string | null): string[] {
  const list = [...spaces];
  if (activeSpace && !list.includes(activeSpace)) list.push(activeSpace);
  return list;
}

