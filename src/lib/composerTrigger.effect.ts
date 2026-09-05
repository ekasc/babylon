import * as Effect from "effect/Effect";
import { detectComposerTrigger, type ComposerTrigger } from "./composerTrigger";

export const detectComposerTriggerEffect = (
  text: string,
  cursor: number,
  isWhitespaceChar?: (char: string) => boolean,
): Effect.Effect<ComposerTrigger | null> =>
  Effect.sync(() => detectComposerTrigger(text, cursor, isWhitespaceChar));
