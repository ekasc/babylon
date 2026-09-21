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
  // The palette literal below is non-empty, so the modulo index always hits;
  // the fallback only satisfies the checker, it never runs.
  return PROJECT_PALETTE[hashStr(cwd) % PROJECT_PALETTE.length] ?? "#8b5cf6";
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// Distinct outline icons assigned per project. Same hash stability as color:
// a project keeps its icon across restarts.
export const PROJECT_ICONS = [
  "folder",
  "layers",
  "cpu",
  "terminal",
  "flask",
  "branch",
  "archive",
  "bolt",
  "shield",
  "chat",
] as const;

export type ProjectIconKey = (typeof PROJECT_ICONS)[number];

export function projectIcon(cwd: string): ProjectIconKey {
  return PROJECT_ICONS[hashStr(cwd) % PROJECT_ICONS.length] ?? "folder";
}

export interface ProjectIdentity {
  icon: ProjectIconKey;
  color: string;
}

// Full identity for every cwd in the set. Icons are unique per set when the
// set fits the icon pool; on repeat (hash collision or more projects than
// icons) the icon is kept and the color shifts to the next unused palette
// slot. Sorted internally so the result never depends on input order.
export function assignProjectIdentities(cwds: string[]): Map<string, ProjectIdentity> {
  const sorted = [...new Set(cwds)].sort();
  const byIcon = new Map<ProjectIconKey, string[]>();
  for (const cwd of sorted) {
    const icon = projectIcon(cwd);
    const arr = byIcon.get(icon) ?? [];
    arr.push(cwd);
    byIcon.set(icon, arr);
  }
  const usedColors = new Set<string>();
  const out = new Map<string, ProjectIdentity>();
  for (const cwd of sorted) {
    const icon = projectIcon(cwd);
    const rank = byIcon.get(icon)!.indexOf(cwd);
    let color = projectColor(cwd);
    if (rank > 0) {
      const base = PROJECT_PALETTE.indexOf(color as (typeof PROJECT_PALETTE)[number]);
      for (let k = 1; k <= PROJECT_PALETTE.length; k++) {
        const candidate = PROJECT_PALETTE[(base + k) % PROJECT_PALETTE.length];
        if (candidate === undefined) break;
        if (!usedColors.has(candidate)) {
          color = candidate;
          break;
        }
      }
    }
    usedColors.add(color);
    out.set(cwd, { icon, color });
  }
  return out;
}
