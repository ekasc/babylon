import * as Effect from "effect/Effect";
import { normalizeSearchQuery, scoreQueryMatch, type RankedSearchResult } from "./searchRanking";

export const rankCommandsEffect = (
  commands: Array<{ name: string; description?: string; source: string; argumentHint?: string }>,
  query: string,
  limit = 20,
): Effect.Effect<Array<{ name: string; description?: string; source: string; argumentHint?: string }>> =>
  Effect.sync(() => {
    const needle = normalizeSearchQuery(query);
    if (!needle) return commands.slice(0, limit);
    const ranked = commands
      .map((command, index) => {
        const name = normalizeSearchQuery(command.name);
        const description = normalizeSearchQuery(command.description ?? "");
        const nameScore = scoreQueryMatch({
          value: name,
          query: needle,
          exactBase: 0,
          prefixBase: 10,
          boundaryBase: 20,
          includesBase: 40,
          fuzzyBase: 80,
        });
        const descScore = description
          ? scoreQueryMatch({
              value: description,
              query: needle,
              exactBase: 50,
              includesBase: 60,
              fuzzyBase: 90,
            })
          : null;
        const score = nameScore !== null ? nameScore : descScore !== null ? descScore + 100 : null;
        return score !== null ? { command, score, index } : null;
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .slice(0, limit)
      .map((e) => e.command);
    return ranked;
  });

export const scoreQueryMatchEffect = (input: {
  value: string;
  query: string;
  exactBase: number;
  prefixBase?: number;
  boundaryBase?: number;
  includesBase?: number;
  fuzzyBase?: number;
  boundaryMarkers?: readonly string[];
}): Effect.Effect<number | null> => Effect.sync(() => scoreQueryMatch(input) as any);
