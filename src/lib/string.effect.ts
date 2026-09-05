import * as Effect from "effect/Effect";
import { truncate } from "./string";

export const truncateEffect = (text: string, maxLength?: number): Effect.Effect<string> =>
  Effect.sync(() => truncate(text, maxLength));
