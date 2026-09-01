import * as Effect from "effect/Effect";
import { formatCount, formatPercent, formatTokens, formatUsd } from "./usageFormat";

export const formatTokensEffect = (value: number): Effect.Effect<string> => Effect.sync(() => formatTokens(value));
export const formatUsdEffect = (value: number): Effect.Effect<string> => Effect.sync(() => formatUsd(value));
export const formatCountEffect = (value: number): Effect.Effect<string> => Effect.sync(() => formatCount(value));
export const formatPercentEffect = (share: number, digits?: number): Effect.Effect<string> =>
  Effect.sync(() => formatPercent(share, digits));
