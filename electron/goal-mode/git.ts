import { spawn } from "node:child_process";

// Minimal vendor of the goal-mode git helpers: the worktree files changed
// since HEAD, used to decide the goal's verifying/executing status after
// each turn. Read-only git plumbing; never mutates the repo.

interface ProcessResult {
  stdout: string;
  code: number;
}

function runGit(cwd: string | undefined, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 15000);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 1024 * 1024) stdout += chunk.toString("utf-8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout: "", code: -1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), code: code ?? -1 });
    });
  });
}

async function trackedChangedFiles(cwd?: string): Promise<string[]> {
  const head = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) return [];
  const result = await runGit(cwd, ["diff", "--name-only", "HEAD", "--"]);
  return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
}

async function untrackedFiles(cwd?: string): Promise<string[]> {
  const result = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
  return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
}

/** Sorted worktree paths changed since HEAD (empty outside a repo). */
export async function goalChangedFiles(cwd?: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([trackedChangedFiles(cwd), untrackedFiles(cwd)]);
  return [...new Set([...tracked, ...untracked])].sort();
}
