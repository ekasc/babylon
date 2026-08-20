// Multi-hue accent palette for per-project color coding. Vibrant, distinct hues
// chosen to pop against the near-black dark canvas while staying cohesive.
export const PROJECT_PALETTE = [
  "#8b5cf6", // violet
  "#60a5fa", // blue
  "#22d3ee", // cyan
  "#34d399", // emerald
  "#fbbf24", // amber
  "#fb923c", // orange
  "#fb7185", // rose
  "#e879f9", // fuchsia
] as const;

// Deterministic, stable color for a project (keyed by its cwd) so the same
// project always reads with the same accent across sessions and restarts.
export function projectColor(cwd: string): string {
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = (h * 31 + cwd.charCodeAt(i)) >>> 0;
  return PROJECT_PALETTE[h % PROJECT_PALETTE.length];
}
