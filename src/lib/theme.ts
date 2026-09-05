import { getWithFallback } from "./storage";
import { RESERVED_THEME_IDS } from "./themePalettes";

export type ThemePref = "light" | "dark" | "system";
export type ThemeId = "terminal" | "excalidraw";

/** Apply mode (light/dark/system), controls .dark class */
export function applyTheme(theme: ThemePref): void {
  localStorage.setItem("babylon:theme", theme);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = theme === "dark" || (theme === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
}

export function loadThemePref(): ThemePref {
  const t = getWithFallback("theme");
  return t === "light" || t === "dark" || t === "system" ? (t as ThemePref) : "system";
}

/** Apply theme id (terminal/excalidraw), controls .theme-* class, each theme defines its own light+dark */
export function applyThemeId(id: ThemeId): void {
  localStorage.setItem("babylon:themeId", id);
  document.documentElement.classList.toggle("theme-excalidraw", id === "excalidraw");
  document.documentElement.classList.toggle("theme-terminal", id === "terminal");
}

export function loadThemeId(): ThemeId {
  const t = getWithFallback("themeId");
  return t === "excalidraw" || t === "terminal" ? (t as ThemeId) : "terminal";
}

export function applySystemFonts(enabled: boolean): void {
  document.documentElement.classList.toggle("system-fonts", enabled);
  document.documentElement.classList.toggle("bundled-fonts", !enabled);
}

export function loadSystemFontsPref(): boolean {
  const v = getWithFallback("useSystemFonts");
  if (v === "true") return true;
  if (v === "false") return false;
  return true;
}

export const MONO_FONTS = [
  { id: "system", label: "System Default", stack: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace" },
  { id: "SF Mono", label: "SF Mono", stack: "\"SF Mono\", ui-monospace, SFMono-Regular, Menlo, monospace" },
  { id: "Menlo", label: "Menlo", stack: "Menlo, ui-monospace, SFMono-Regular, monospace" },
  { id: "JetBrains Mono", label: "JetBrains Mono", stack: "\"JetBrains Mono\", ui-monospace, SFMono-Regular, monospace" },
  { id: "Fira Code", label: "Fira Code", stack: "\"Fira Code\", ui-monospace, SFMono-Regular, monospace" },
  { id: "Berkeley Mono", label: "Berkeley Mono", stack: "\"Berkeley Mono\", ui-monospace, SFMono-Regular, monospace" },
  { id: "Geist Mono", label: "Geist Mono", stack: "\"Geist Mono\", ui-monospace, SFMono-Regular, monospace" },
  { id: "Cascadia Code", label: "Cascadia Code", stack: "\"Cascadia Code\", ui-monospace, SFMono-Regular, monospace" },
  { id: "Source Code Pro", label: "Source Code Pro", stack: "\"Source Code Pro\", ui-monospace, SFMono-Regular, monospace" },
  { id: "IBM Plex Mono", label: "IBM Plex Mono", stack: "\"IBM Plex Mono\", ui-monospace, SFMono-Regular, monospace" },
  { id: "Dank Mono", label: "Dank Mono", stack: "\"Dank Mono\", ui-monospace, SFMono-Regular, monospace" },
  { id: "Miracode", label: "Miracode", stack: "\"Miracode\", ui-monospace, SFMono-Regular, Menlo, monospace" },
] as const;

export function monoStack(family: string): string {
  const entry = MONO_FONTS.find((f) => f.id === family);
  if (entry) return entry.stack;
  if (family === "system") return MONO_FONTS[0].stack;
  return `"${family.replace(/"/g, "\\\"")}", ui-monospace, SFMono-Regular, Menlo, monospace`;
}

export function applyMonoFont(family: string): void {
  const stack = monoStack(family);
  document.documentElement.style.setProperty("--mono", stack);
  document.documentElement.style.setProperty("--font-mono", stack);
  localStorage.setItem("babylon:monoFont", family);
}

export function applySansFont(family: string): void {
  const stack = family === "system" ? "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", \"Segoe UI\", sans-serif" : `"${family.replace(/"/g, '\\"')}", -apple-system, BlinkMacSystemFont, sans-serif`;
  document.documentElement.style.setProperty("--font-sans", stack);
  localStorage.setItem("babylon:sansFont", family);
}

export function loadSansFontPref(): string {
  return getWithFallback("sansFont") || "system";
}

export function applyRadius(radius: string): void {
  document.documentElement.style.setProperty("--radius", radius);
  document.documentElement.style.setProperty("--radius-sm", radius);
  document.documentElement.style.setProperty("--radius-lg", radius);
  localStorage.setItem("babylon:radius", radius);
}

export function loadMonoFontPref(): string {
  const v = getWithFallback("monoFont");
  if (v) return v;
  return "system";
}

export function isReservedThemeId(id: string): boolean {
  return RESERVED_THEME_IDS.has(id);
}
