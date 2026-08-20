import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_BYTES = 200 * 1024;
const GIT_TIMEOUT_MS = 120_000;

export interface SnapshotCapture {
  root: string;
  tree: string;
  excluded: Array<{ path: string; size: number; mtimeMs: number }>;
}

export interface RestoreChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface TurnFileChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

interface Repository {
  root: string;
  gitDir: string;
}

interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
}

function key(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function safeTree(input: string): string {
  if (!/^[0-9a-f]{40,64}$/i.test(input)) throw new Error("invalid project snapshot");
  return input;
}

function safeRelative(root: string, input: string): string {
  if (!input || input.length > 4096 || input.includes("\0")) throw new Error("invalid snapshot path");
  const absolute = resolve(root, input);
  const rel = relative(root, absolute).replaceAll("\\", "/");
  if (!rel || rel === "." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("snapshot path escapes the project");
  }
  return rel;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function assertSafeTarget(root: string, rel: string): Promise<string> {
  const target = resolve(root, rel);
  if (!contained(root, target)) throw new Error("snapshot path escapes the project");
  let ancestor = dirname(target);
  for (;;) {
    try {
      const real = await fsp.realpath(ancestor);
      if (!contained(root, real)) throw new Error("snapshot path traverses a symlink outside the project");
      return target;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor || !contained(root, parent)) throw new Error("invalid snapshot path");
      ancestor = parent;
    }
  }
}

function pathspec(paths: string[]): Buffer {
  return Buffer.from(paths.map((path) => `:(top,literal)${path}\0`).join(""), "utf8");
}

async function run(command: string, args: string[], cwd: string, stdin?: Buffer): Promise<GitResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, GIT_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > MAX_OUTPUT) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize <= MAX_OUTPUT) stderr.push(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutSize > MAX_OUTPUT) {
        reject(new Error(`${command} output exceeded the limit`));
        return;
      }
      resolveRun({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 1 });
    });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function splitNul(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

export class SnapshotStore {
  constructor(private readonly stateDir: string) {}

  private async sourceRoot(cwd: string): Promise<string | null> {
    try {
      const result = await run("git", ["rev-parse", "--show-toplevel"], cwd);
      if (result.code !== 0) return null;
      const root = result.stdout.toString("utf8").trim();
      return root ? await fsp.realpath(root) : null;
    } catch {
      return null;
    }
  }

  async available(cwd: string): Promise<boolean> {
    return (await this.sourceRoot(cwd)) !== null;
  }

  private async repository(cwd: string): Promise<Repository | null> {
    const root = await this.sourceRoot(cwd);
    if (!root) return null;
    const statePath = resolve(this.stateDir);
    const stateParent = await fsp.realpath(dirname(statePath)).catch(() => dirname(statePath));
    const canonicalStatePath = join(stateParent, basename(statePath));
    if (contained(root, canonicalStatePath)) throw new Error("snapshot storage must be outside the project worktree");
    const gitDir = join(this.stateDir, key(root));
    const head = join(gitDir, "HEAD");
    try {
      await fsp.access(head);
    } catch {
      await fsp.mkdir(dirname(gitDir), { recursive: true, mode: 0o700 });
      const init = await run("git", ["init", "--bare", gitDir], root);
      if (init.code !== 0) throw new Error("failed to initialize rollback snapshots");
      for (const [name, value] of [
        ["core.bare", "false"],
        ["core.autocrlf", "false"],
        ["core.longpaths", "true"],
        ["core.symlinks", "true"],
        ["core.fsmonitor", "false"],
        ["feature.manyFiles", "true"],
        ["index.version", "4"],
      ]) {
        const configured = await run("git", ["--git-dir", gitDir, "config", name, value], root);
        if (configured.code !== 0) throw new Error("failed to configure rollback snapshots");
      }
      const common = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
      if (common.code === 0) {
        const objects = join(common.stdout.toString("utf8").trim(), "objects");
        try {
          const realObjects = await fsp.realpath(objects);
          await fsp.mkdir(join(gitDir, "objects", "info"), { recursive: true, mode: 0o700 });
          await fsp.writeFile(join(gitDir, "objects", "info", "alternates"), `${realObjects}\n`, { mode: 0o600 });
        } catch {
          // Object reuse is an optimization; snapshots remain independently valid.
        }
      }
    }
    return { root, gitDir };
  }

  private args(repo: Repository, args: string[]): string[] {
    return ["-c", "core.autocrlf=false", "-c", "core.quotepath=false", "--git-dir", repo.gitDir, "--work-tree", repo.root, ...args];
  }

  async capture(cwd: string): Promise<SnapshotCapture | null> {
    const repo = await this.repository(cwd);
    if (!repo) return null;

    const [trackedResult, untrackedResult] = await Promise.all([
      run("git", ["-c", "core.quotepath=false", "ls-files", "-z", "--cached"], repo.root),
      run("git", ["-c", "core.quotepath=false", "ls-files", "-z", "--others", "--exclude-standard"], repo.root),
    ]);
    if (trackedResult.code !== 0 || untrackedResult.code !== 0) throw new Error("failed to enumerate snapshot files");

    const tracked = splitNul(trackedResult.stdout);
    const untracked = splitNul(untrackedResult.stdout);
    const include = new Set<string>();
    const stateRoot = resolve(this.stateDir);
    const isInternal = (candidate: string) => {
      const absolute = resolve(repo.root, candidate);
      const rel = relative(stateRoot, absolute);
      return !rel.startsWith("..") && !isAbsolute(rel);
    };
    const excluded: SnapshotCapture["excluded"] = [];
    for (const candidate of tracked) {
      if (isInternal(candidate)) continue;
      const rel = safeRelative(repo.root, candidate);
      try {
        await fsp.lstat(join(repo.root, rel));
        include.add(rel);
      } catch {
        // Deleted tracked paths are represented by absence from the tree.
      }
    }
    for (const candidate of untracked) {
      if (isInternal(candidate)) continue;
      const rel = safeRelative(repo.root, candidate);
      try {
        const stat = await fsp.lstat(join(repo.root, rel));
        if (stat.isFile() && stat.size > MAX_UNTRACKED_BYTES) {
          excluded.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs });
          continue;
        }
        include.add(rel);
      } catch {
        // A concurrently removed file is absent from this tree.
      }
    }

    const hidden = await run("git", this.args(repo, ["ls-files", "-z"]), repo.root);
    if (hidden.code !== 0) throw new Error("failed to read snapshot index");
    const paths = [...include].sort();
    const removed = splitNul(hidden.stdout).filter((path) => !include.has(path));
    if (removed.length) {
      const dropped = await run(
        "git",
        this.args(repo, ["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
        repo.root,
        pathspec(removed)
      );
      if (dropped.code !== 0) throw new Error("failed to update snapshot index");
    }
    if (paths.length) {
      const staged = await run(
        "git",
        this.args(repo, ["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"]),
        repo.root,
        pathspec(paths)
      );
      if (staged.code !== 0) throw new Error("failed to capture project snapshot");
    }
    const tree = await run("git", this.args(repo, ["write-tree"]), repo.root);
    if (tree.code !== 0) throw new Error("failed to write project snapshot");
    const hash = tree.stdout.toString("utf8").trim();
    if (!/^[0-9a-f]{40,64}$/i.test(hash)) throw new Error("invalid project snapshot");
    return { root: repo.root, tree: hash, excluded };
  }

  async changedFiles(cwd: string, from: string, to: string): Promise<string[]> {
    const repo = await this.repository(cwd);
    if (!repo) throw new Error("rollback requires a Git project");
    const result = await run("git", this.args(repo, ["diff", "--name-only", "-z", "--no-renames", safeTree(from), safeTree(to), "--", "."]), repo.root);
    if (result.code !== 0) throw new Error("failed to compare project snapshots");
    return splitNul(result.stdout).map((path) => safeRelative(repo.root, path));
  }

  async turnChanges(cwd: string, from: string, to: string): Promise<TurnFileChange[]> {
    const repo = await this.repository(cwd);
    if (!repo) throw new Error("rollback requires a Git project");
    const [nameStatus, numstat] = await Promise.all([
      run("git", this.args(repo, ["diff", "--name-status", "-z", "--no-renames", safeTree(from), safeTree(to), "--", "."]), repo.root),
      run("git", this.args(repo, ["diff", "--numstat", "-z", "--no-renames", safeTree(from), safeTree(to), "--", "."]), repo.root),
    ]);
    if (nameStatus.code !== 0 || numstat.code !== 0) throw new Error("failed to compare project snapshots");
    const kinds = new Map<string, TurnFileChange["kind"]>();
    const statusParts = nameStatus.stdout.toString("utf8").split("\0");
    for (let i = 0; i + 1 < statusParts.length; i += 2) {
      const status = statusParts[i];
      const path = statusParts[i + 1];
      if (!status || !path) break;
      kinds.set(safeRelative(repo.root, path), status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : "modified");
    }
    const changes = new Map<string, TurnFileChange>();
    const numstatParts = numstat.stdout.toString("utf8").split("\0");
    for (const part of numstatParts) {
      if (!part) continue;
      const tab = part.lastIndexOf("\t");
      if (tab < 0) continue;
      const counts = part.slice(0, tab);
      const path = part.slice(tab + 1);
      const additions = parseInt(counts.split("\t")[0] ?? "0", 10);
      const deletions = parseInt(counts.split("\t")[1] ?? "0", 10);
      changes.set(path, {
        path,
        kind: kinds.get(path) ?? "modified",
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
      });
    }
    return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async fileDiff(cwd: string, from: string, to: string, input: string): Promise<{ diff: string; truncated: boolean }> {
    const repo = await this.repository(cwd);
    if (!repo) throw new Error("rollback requires a Git project");
    const rel = safeRelative(repo.root, input);
    const result = await run(
      "git",
      this.args(repo, ["diff", "--no-ext-diff", "--no-color", "--no-renames", "--patch", safeTree(from), safeTree(to), "--", `:(top,literal)${rel}`]),
      repo.root
    );
    if (result.code !== 0) throw new Error(`failed to diff ${rel}`);
    const raw = result.stdout.toString("utf8");
    const truncated = raw.length > MAX_DIFF_BYTES;
    return { diff: raw.slice(0, MAX_DIFF_BYTES), truncated };
  }

  private async objectAt(repo: Repository, tree: string, rel: string): Promise<string | null> {
    const result = await run("git", this.args(repo, ["rev-parse", "--verify", `${safeTree(tree)}:${rel}`]), repo.root);
    if (result.code !== 0) return null;
    const object = result.stdout.toString("utf8").trim();
    return /^[0-9a-f]{40,64}$/i.test(object) ? object : null;
  }

  private async existsIn(repo: Repository, tree: string, rel: string): Promise<boolean> {
    return (await this.objectAt(repo, tree, rel)) !== null;
  }

  async preview(cwd: string, currentTree: string, restore: Record<string, string>): Promise<RestoreChange[]> {
    const repo = await this.repository(cwd);
    if (!repo) throw new Error("rollback requires a Git project");
    const changes: RestoreChange[] = [];
    for (const [input, tree] of Object.entries(restore)) {
      const rel = safeRelative(repo.root, input);
      const [current, target] = await Promise.all([
        this.objectAt(repo, currentTree, rel),
        this.objectAt(repo, tree, rel),
      ]);
      if (current === target) continue;
      if (current && target) changes.push({ path: rel, status: "modified" });
      else if (target) changes.push({ path: rel, status: "added" });
      else if (current) changes.push({ path: rel, status: "deleted" });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  async restore(cwd: string, restore: Record<string, string>): Promise<void> {
    const repo = await this.repository(cwd);
    if (!repo) throw new Error("rollback requires a Git project");
    for (const [input, tree] of Object.entries(restore)) {
      const rel = safeRelative(repo.root, input);
      const target = await assertSafeTarget(repo.root, rel);
      const snapshot = safeTree(tree);
      if (await this.existsIn(repo, snapshot, rel)) {
        const result = await run("git", this.args(repo, ["checkout", snapshot, "--", `:(top,literal)${rel}`]), repo.root);
        if (result.code !== 0) throw new Error(`failed to restore ${rel}`);
      } else {
        await fsp.rm(target, { recursive: true, force: true });
      }
    }
  }
}
