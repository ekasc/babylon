import * as Effect from "effect/Effect";
import { RESERVED_THEME_IDS, UNPUBLISHABLE_THEME_IDS } from "./themePalettes";

export const isReservedThemeIdEffect = (id: string): Effect.Effect<boolean> =>
  Effect.sync(() => RESERVED_THEME_IDS.has(id));

export const isUnpublishableThemeIdEffect = (id: string): Effect.Effect<boolean> =>
  Effect.sync(() => UNPUBLISHABLE_THEME_IDS.has(id));
