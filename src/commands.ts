import type { CommandInfo } from "./bridge";
import { normalizeSearchQuery, scoreQueryMatch } from "./lib/searchRanking";

export function commandTokenAtStart(text: string): string | null {
  if (!text.startsWith("/") || text.includes("\n")) return null;
  const token = text.slice(1).split(/\s/, 1)[0] ?? "";
  return text.slice(1).includes(" ") || text.slice(1).includes("\t") ? null : token;
}

export function rankCommands(commands: CommandInfo[], query: string, limit = 20): CommandInfo[] {
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
    .map((entry) => entry.command);
  return ranked;
}

export function insertCommand(command: CommandInfo): string {
  return `/${command.name}${command.argumentHint ? " " : ""}`;
}
