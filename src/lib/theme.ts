export type ThemePref = "light" | "dark" | "system";

/** Apply a theme preference to the document root and persist it. */
export function applyTheme(theme: ThemePref): void {
  localStorage.setItem("pideck:theme", theme);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = theme === "dark" || (theme === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
}

export function loadThemePref(): ThemePref {
  const t = localStorage.getItem("pideck:theme");
  return t === "light" || t === "dark" || t === "system" ? t : "system";
}

export function applySystemFonts(enabled: boolean): void {
  document.documentElement.classList.toggle("system-fonts", enabled);
  document.documentElement.classList.toggle("bundled-fonts", !enabled);
}

export function loadSystemFontsPref(): boolean {
  const v = localStorage.getItem("pideck:useSystemFonts");
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
  document.documentElement.style.setProperty("--mono", monoStack(family));
  localStorage.setItem("pideck:monoFont", family);
}

export function loadMonoFontPref(): string {
  const v = localStorage.getItem("pideck:monoFont");
  if (v) return v;
  return "system";
}
