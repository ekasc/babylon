import * as Effect from "effect/Effect";
import { isDevProxiedPath } from "./devProxy";

export const isDevProxiedPathEffect = (pathname: string): Effect.Effect<boolean> =>
  Effect.sync(() => isDevProxiedPath(pathname));
