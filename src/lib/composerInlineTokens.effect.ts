import * as Effect from "effect/Effect";
import { collectComposerInlineTokens, type CollectComposerInlineTokensOptions, type ComposerInlineToken } from "./composerInlineTokens";

export const collectComposerInlineTokensEffect = (
  text: string,
  options?: CollectComposerInlineTokensOptions,
): Effect.Effect<ReadonlyArray<ComposerInlineToken>> =>
  Effect.sync(() => collectComposerInlineTokens(text, options));
