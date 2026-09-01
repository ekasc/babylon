import * as Effect from "effect/Effect";
import { rankCommands } from "./commands";
import type { CommandInfo } from "./bridge";

export const rankCommandsEffect = (
  commands: CommandInfo[],
  query: string,
  limit?: number,
): Effect.Effect<CommandInfo[]> => Effect.sync(() => rankCommands(commands, query, limit));
