import * as Effect from "effect/Effect";
import { cachedHighlight, highlight } from "./highlight";

export const highlightEffect = (code: string, lang?: string): Effect.Effect<string | null> =>
  Effect.promise(() => highlight(code, lang)).pipe(Effect.catchAll(() => Effect.succeed(null)));

export const cachedHighlightEffect = (code: string, lang?: string): Effect.Effect<string | null> =>
  Effect.sync(() => cachedHighlight(code, lang));
