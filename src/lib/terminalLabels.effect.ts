import * as Effect from "effect/Effect";
import { getTerminalLabel, nextTerminalId, resolveTerminalSessionLabel } from "./terminalLabels";

export const getTerminalLabelEffect = (terminalId: string): Effect.Effect<string> =>
  Effect.sync(() => getTerminalLabel(terminalId));

export const resolveTerminalSessionLabelEffect = (
  terminalId: string,
  summary: { label?: string | null } | null | undefined,
): Effect.Effect<string> => Effect.sync(() => resolveTerminalSessionLabel(terminalId, summary));

export const nextTerminalIdEffect = (existingTerminalIds: ReadonlyArray<string>): Effect.Effect<string> =>
  Effect.sync(() => nextTerminalId(existingTerminalIds));
