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
    const inside = await git(["rev-parse", "--is-inside-work-tree"], cwd);
    if (inside !== "true") return { isRepo: false };
    const [root, branch, gitDir] = await Promise.all([
      git(["rev-parse", "--show-toplevel"], cwd),
      git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).catch(() => "HEAD"),
      git(["rev-parse", "--git-dir"], cwd),
    ]);
    return {
      isRepo: true,
      root,
      branch,
      isLinkedWorktree: gitDir.replace(/\\/g, "/").includes(".git/worktrees/"),
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

/** Computes the full working-tree git status for a directory. */
export async function gitStatus(cwd: string): Promise<GitStatusResult> {
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
    const [behind, ahead] = counts.split("\t").map((n) => parseInt(n, 10) || 0);
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
