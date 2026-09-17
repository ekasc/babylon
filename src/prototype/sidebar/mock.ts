// Mock data for the sidebar UI prototype. Throwaway — no persistence, no backend.

export type Exec = "idle" | "working" | "waiting" | "approval" | "failed";

export interface Session {
  id: string;
  title: string;
  project: string;
  cwd: string;
  exec: Exec;
  unread: boolean;
  pinned?: boolean;
  settled?: boolean;
  /** threads/subagents currently alive under this session */
  agents?: number;
  minutesAgo: number;
}

export interface Project {
  name: string;
  cwd: string;
  color: string;
}

export const PROJECTS: Project[] = [
  { name: "babylon", cwd: "/Users/me/babylon", color: "var(--accent)" },
  { name: "pideck-site", cwd: "/Users/me/pideck-site", color: "var(--ok)" },
  { name: "ml-lab", cwd: "/Users/me/ml-lab", color: "var(--warn)" },
  { name: "infra", cwd: "/Users/me/infra", color: "#a78bfa" },
];

export const SESSIONS: Session[] = [
  { id: "s1", title: "Streaming render perf", project: "babylon", cwd: "/Users/me/babylon", exec: "working", unread: false, agents: 2, minutesAgo: 0, pinned: true },
  { id: "s2", title: "Rollback plan review", project: "babylon", cwd: "/Users/me/babylon", exec: "approval", unread: false, minutesAgo: 3 },
  { id: "s3", title: "Auth token refresh", project: "infra", cwd: "/Users/me/infra", exec: "failed", unread: true, minutesAgo: 12 },
  { id: "s4", title: "Landing hero copy", project: "pideck-site", cwd: "/Users/me/pideck-site", exec: "idle", unread: true, minutesAgo: 18 },
  { id: "s5", title: "Eval harness v2", project: "ml-lab", cwd: "/Users/me/ml-lab", exec: "working", unread: false, agents: 1, minutesAgo: 6 },
  { id: "s6", title: "Worktree cleanup", project: "babylon", cwd: "/Users/me/babylon", exec: "waiting", unread: false, minutesAgo: 26 },
  { id: "s7", title: "Deploy pipeline notes", project: "infra", cwd: "/Users/me/infra", exec: "idle", unread: false, minutesAgo: 54 },
  { id: "s8", title: "Context compaction spike", project: "ml-lab", cwd: "/Users/me/ml-lab", exec: "idle", unread: false, settled: true, minutesAgo: 95 },
  { id: "s9", title: "Pricing table rework", project: "pideck-site", cwd: "/Users/me/pideck-site", exec: "idle", unread: false, minutesAgo: 130 },
  { id: "s10", title: "LSP restart loop", project: "babylon", cwd: "/Users/me/babylon", exec: "failed", unread: true, minutesAgo: 180 },
  { id: "s11", title: "Dataset dedupe script", project: "ml-lab", cwd: "/Users/me/ml-lab", exec: "idle", unread: false, minutesAgo: 300 },
  { id: "s12", title: "Terraform drift", project: "infra", cwd: "/Users/me/infra", exec: "idle", unread: false, minutesAgo: 1500 },
  { id: "s13", title: "OG image generator", project: "pideck-site", cwd: "/Users/me/pideck-site", exec: "idle", unread: false, settled: true, minutesAgo: 2900 },
  { id: "s14", title: "Session index rewrite", project: "babylon", cwd: "/Users/me/babylon", exec: "idle", unread: false, settled: true, minutesAgo: 4300 },
];

export function relTime(min: number): string {
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function projectColor(name: string): string {
  return PROJECTS.find((p) => p.name === name)?.color ?? "var(--dim)";
}

export function statusColor(exec: Exec, unread: boolean): string {
  if (exec === "approval" || exec === "waiting") return "var(--warn)";
  if (exec === "failed") return "var(--err)";
  if (exec === "working") return "var(--running)";
  if (unread) return "var(--accent)";
  return "var(--line-strong)";
}

export function statusLabel(exec: Exec, unread: boolean): string {
  if (exec === "approval") return "needs approval";
  if (exec === "waiting") return "waiting";
  if (exec === "failed") return "failed";
  if (exec === "working") return "working";
  if (unread) return "unread";
  return "idle";
}
