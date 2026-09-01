import * as Effect from "effect/Effect";
import { Spring, type SpringConfig } from "./spring";

export const makeSpringEffect = (
  x0: number,
  target: number,
  cfg: SpringConfig,
  onUpdate: (x: number) => void,
  onSettled?: () => void,
): Effect.Effect<Spring> => Effect.sync(() => new Spring(x0, target, cfg, onUpdate, onSettled));
