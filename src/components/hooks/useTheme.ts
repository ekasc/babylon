import { useEffect, useState } from "react";
import { bridge } from "../../bridge";
import { setWithFallback } from "../../lib/storage";
import {
  applyMonoFont,
  applySystemFonts,
  applyTheme,
  applyThemeId,
  loadMonoFontPref,
  loadSystemFontsPref,
  loadThemeId,
  loadThemePref,
  type ThemeId,
  type ThemePref,
} from "../../lib/theme";

export function useTheme() {
  const [themePref, setThemePref] = useState<ThemePref>(loadThemePref);
  const [themeId, setThemeId] = useState<ThemeId>(loadThemeId);

  // Theme is owned here (Settings → Appearance) and applied on change.
  useEffect(() => {
    applyTheme(themePref);
  }, [themePref]);
  useEffect(() => {
    applyThemeId(themeId);
  }, [themeId]);

  useEffect(() => {
    applySystemFonts(loadSystemFontsPref());
    applyMonoFont(loadMonoFontPref());
    applyThemeId(loadThemeId());
    void bridge
      .getSettings()
      .then((s) => {
        const enabled = s?.appearance?.useSystemFonts ?? true;
        const family = s?.appearance?.monoFontFamily ?? "system";
        applySystemFonts(enabled);
        applyMonoFont(family);
        applyThemeId(loadThemeId());
        setWithFallback("useSystemFonts", String(enabled));
        const themeFromSettings = s?.appearance?.theme;
        if (themeFromSettings === "light" || themeFromSettings === "dark" || themeFromSettings === "system") {
          applyTheme(themeFromSettings);
          setThemePref(themeFromSettings);
        }
      })
      .catch(() => undefined);
  }, []);

  return { themePref, themeId, setThemePref, setThemeId };
}
