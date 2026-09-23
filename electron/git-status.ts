import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export interface GitInfo {
  isRepo: boolean;
  root?: string;
  branch?: string;
  isLinkedWorktree?: boolean;
}

export async function gitInfo(cwd: string): Promise<GitInfo> {
  try {
    // One spawn instead of four: rev-parse prints one line per operand, in
    // order. Spawning a git per operand turned every status poll into a
    // fork storm (see gitStatus caching below).
    const out = await git(
      ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--abbrev-ref", "HEAD", "--git-dir"],
      cwd
    );
    const [inside, root, branch, gitDir] = out.split("\n");
    if (inside !== "true") return { isRepo: false };
    return {
      isRepo: true,
      root,
      branch: branch || "HEAD",
      isLinkedWorktree: (gitDir ?? "").replace(/\\/g, "/").includes(".git/worktrees/"),
    };
  } catch {
    return { isRepo: false };
  }
}

export interface GitFileChange {
  path: string;
  status: string;
}

export interface GitStatusResult {
  isRepo: boolean;
  root?: string;
  branch?: string;
  isWorktree?: boolean;
  dirty: GitFileChange[];
  ahead: number;
  behind: number;
}

// Per-cwd result cache + in-flight dedup for gitStatus. The renderer polls
// on a timer and re-renders constantly while agents stream; without this,
// every poll cycle spawned ~3 gits per project cwd (rev-parse, status,
// rev-list), and overlapping cycles stacked further bursts that showed up as
// sustained main-process CPU and zombie accumulation. The timer period
// (30s) exceeds the positive TTL, so scheduled polls still read fresh data;
// rapid refires in between are served from cache. Mutating git IPC handlers
// must call invalidateGitStatus so post-commit/stage reads are fresh.
const POSITIVE_TTL_MS = 15_000;
const NEGATIVE_TTL_MS = 30_000;

interface StatusCacheEntry {
  at: number;
  value: GitStatusResult;
}

const statusCache = new Map<string, StatusCacheEntry>();
const statusInFlight = new Map<string, Promise<GitStatusResult>>();

/** Drop the cached status for a cwd after a mutating git operation. */
export function invalidateGitStatus(cwd: string): void {
  statusCache.delete(cwd);
}

export async function gitStatus(cwd: string): Promise<GitStatusResult> {
  const now = Date.now();
  const cached = statusCache.get(cwd);
  if (cached) {
    const ttl = cached.value.isRepo ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (now - cached.at < ttl) return cached.value;
  }
  // Concurrent callers (timer + hover + full refresh coinciding) share one
  // computation instead of each spawning their own git burst.
  const pending = statusInFlight.get(cwd);
  if (pending) return pending;
  const run = computeGitStatus(cwd).then((result) => {
    statusCache.set(cwd, { at: Date.now(), value: result });
    return result;
  }).finally(() => {
    if (statusInFlight.get(cwd) === run) statusInFlight.delete(cwd);
  });
  statusInFlight.set(cwd, run);
  return run;
}

/** Computes the full working-tree git status for a directory. */
async function computeGitStatus(cwd: string): Promise<GitStatusResult> {
  const base = await gitInfo(cwd);
  if (!base.isRepo) return { isRepo: false, dirty: [], ahead: 0, behind: 0 };
  const result: GitStatusResult = {
    isRepo: true,
    root: base.root,
    branch: base.branch,
    isWorktree: base.isLinkedWorktree,
    dirty: [],
    ahead: 0,
    behind: 0,
  };
  try {
    // List concrete untracked files while retaining Git's standard ignore,
    // info/exclude, and global-excludes behavior.
    const porcelain = await git(["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all"], cwd);
    result.dirty = porcelain
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
  } catch {
    /* not a repo or git unavailable */
  }
  try {
    const counts = await git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], cwd);
    const parts = counts.split("\t").map((n) => parseInt(n, 10) || 0);
    const behind = parts[0] ?? 0;
    const ahead = parts[1] ?? 0;
    result.behind = behind;
    result.ahead = ahead;
  } catch {
    /* no upstream configured */
  }
  return result;
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root);
    return true;
  } catch {
    return false;
  }
}
