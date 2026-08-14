import type { CommandInfo, ProjectGroup, SessionMeta } from "./bridge";
import { rankCommands } from "./commands";

// Off-thread-capable palette search. The index is built once per data change
// (pre-lowered haystacks, pre-sorted by recency) so every keystroke is a linear
// includes() scan with no re-sorting and no string lowercasing. This module is
// imported by the search Worker AND used inline as a fallback, so both paths
// share one behavior.

export type PaletteResult =
  | { type: "new"; key: "new" }
  | { type: "session"; key: string; session: SessionMeta; cwd: string }
  | { type: "command"; key: string; command: CommandInfo };

export interface PaletteSearchLimits {
  /** Max sessions when a query is present (empty query uses sessionLimitEmpty). */
  sessionLimit: number;
  sessionLimitEmpty: number;
  /** Max commands when a query is present (empty query uses commandLimitEmpty). */
  commandLimit: number;
  commandLimitEmpty: number;
}

export const DEFAULT_LIMITS: PaletteSearchLimits = {
  sessionLimit: 20,
  sessionLimitEmpty: 8,
  commandLimit: 16,
  commandLimitEmpty: 8,
};

interface SessionEntry {
  key: string;
  cwd: string;
  session: SessionMeta;
  /** Pre-lowered search haystack: name, first user text, and project path. */
  haystack: string;
}

export interface PaletteIndex {
  sessions: SessionEntry[];
  commands: CommandInfo[];
}

export function buildPaletteIndex(groups: ProjectGroup[], commands: CommandInfo[]): PaletteIndex {
  const sessions: SessionEntry[] = [];
  for (const group of groups) {
    for (const session of group.sessions) {
      sessions.push({
        key: session.path,
        cwd: group.cwd,
        session,
        haystack: `${session.name ?? ""} ${session.firstUserText ?? ""} ${group.cwd}`.toLowerCase(),
      });
    }
  }
  // Pre-sorted by recency; searchPalette filters in order and slices, so no
  // per-keystroke sort is ever needed.
  sessions.sort((a, b) => b.session.mtime - a.session.mtime);
  return { sessions, commands };
}

export function searchPalette(
  index: PaletteIndex,
  query: string,
  limits: PaletteSearchLimits = DEFAULT_LIMITS
): PaletteResult[] {
  const needle = query.trim().toLowerCase();
  const results: PaletteResult[] = [{ type: "new", key: "new" }];
  if (needle) {
    let matched = 0;
    for (const entry of index.sessions) {
      if (matched >= limits.sessionLimit) break;
      if (entry.haystack.includes(needle)) {
        results.push({ type: "session", key: entry.key, session: entry.session, cwd: entry.cwd });
        matched++;
      }
    }
    for (const command of rankCommands(index.commands, needle, limits.commandLimit)) {
      results.push({ type: "command", key: `${command.source}:${command.name}`, command });
    }
  } else {
    for (const entry of index.sessions.slice(0, limits.sessionLimitEmpty)) {
      results.push({ type: "session", key: entry.key, session: entry.session, cwd: entry.cwd });
    }
    for (const command of rankCommands(index.commands, "", limits.commandLimitEmpty)) {
      results.push({ type: "command", key: `${command.source}:${command.name}`, command });
    }
  }
  return results;
}
