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
