import * as Effect from "effect/Effect";
import { runBackgroundTick, type BackgroundTickInput, type BackgroundTickOutput } from "./background-controller";

export const runBackgroundTickEffect = (input: BackgroundTickInput): Effect.Effect<BackgroundTickOutput> =>
  Effect.sync(() => runBackgroundTick(input));
