import * as Effect from "effect/Effect";
import { applyMonoFont, applySystemFonts, applyTheme, loadMonoFontPref, loadSystemFontsPref, loadThemePref } from "./theme";

export const applyThemeEffect = (theme: Parameters<typeof applyTheme>[0]): Effect.Effect<void> =>
  Effect.sync(() => applyTheme(theme));

export const loadThemePrefEffect: Effect.Effect<ReturnType<typeof loadThemePref>> = Effect.sync(() =>
  loadThemePref(),
);

export const applySystemFontsEffect = (enabled: boolean): Effect.Effect<void> =>
  Effect.sync(() => applySystemFonts(enabled));

export const loadSystemFontsPrefEffect: Effect.Effect<boolean> = Effect.sync(() => loadSystemFontsPref());

export const applyMonoFontEffect = (family: string): Effect.Effect<void> =>
  Effect.sync(() => applyMonoFont(family));

export const loadMonoFontPrefEffect: Effect.Effect<string> = Effect.sync(() => loadMonoFontPref());
