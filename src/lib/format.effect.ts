import * as Effect from "effect/Effect";
import { formatContextPercent, formatContextWindow, formatNumber, formatTokens } from "./format";

export const formatTokensEffect = (n?: number): Effect.Effect<string> => Effect.sync(() => formatTokens(n));
export const formatNumberEffect = (n?: number): Effect.Effect<string> => Effect.sync(() => formatNumber(n));
export const formatContextWindowEffect = (n?: number): Effect.Effect<string> =>
  Effect.sync(() => formatContextWindow(n));
export const formatContextPercentEffect = (pct?: number, tokens?: number, win?: number): Effect.Effect<string> =>
  Effect.sync(() => formatContextPercent(pct, tokens, win));
