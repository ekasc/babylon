import type { CommandInfo } from "./bridge";

export function commandTokenAtStart(text: string): string | null {
  if (!text.startsWith("/") || text.includes("\n")) return null;
  const token = text.slice(1).split(/\s/, 1)[0] ?? "";
  return text.slice(1).includes(" ") || text.slice(1).includes("\t") ? null : token;
}

export function rankCommands(commands: CommandInfo[], query: string, limit = 20): CommandInfo[] {
  const needle = query.toLowerCase();
  return commands
    .map((command, index) => {
      const name = command.name.toLowerCase();
      const description = command.description?.toLowerCase() ?? "";
      let score = -1;
      if (!needle) score = 10;
      else if (name === needle) score = 100;
      else if (name.startsWith(needle)) score = 80;
      else if (name.split(/[-:]/).some((part) => part.startsWith(needle))) score = 60;
      else if (name.includes(needle)) score = 40;
      else if (description.includes(needle)) score = 20;
      return { command, score, index };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.command);
}

export function insertCommand(command: CommandInfo): string {
  return `/${command.name}${command.argumentHint ? " " : ""}`;
}
