import { createHash } from "node:crypto";
import { promises as fsp, watch, type FSWatcher } from "node:fs";
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

interface ExclusionMap {
  paths: Record<string, { size: number; mtimeMs: number }>;
}

interface RepoWatch {
  watcher: FSWatcher | null;
  /** Paths the kernel reported as changed since the last full capture. An
   *  empty string is a sentinel meaning "assume the whole repo changed". */
  dirty: Set<string>;
  /** Changes observed while a capture was in flight; merged into `dirty`
   *  afterwards so a concurrent edit is never lost. */
  pending: Set<string>;
  capturing: boolean;
  /** Last fully-computed snapshot, returned verbatim while `dirty` is empty. */
  last: SnapshotCapture | null;
  root: string;
  /** Number of consecutive noop fast-path returns since the last full capture. */
  since: number;
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

  /** Resolved git toplevel per cwd, memoized so the noop fast path in
   *  `capture` does not pay a git spawn on every call. The project root does
   *  not move within a session, so staleness is bounded by the lifetime of
   *  this store. */
  private rootCache = new Map<string, string | null>();

  /** Per-repo worktree watchers. A watcher feeds a dirty-path set; when it
   *  is empty the worktree is unchanged since the last capture and `capture`
   *  returns the cached snapshot without touching git. This is what keeps
   *  prompt-start latency flat on large repos instead of re-enumerating the
   *  whole worktree on every turn. */
  private watches = new Map<string, RepoWatch>();

  /** Full reconciliations are forced this often to bound staleness from any
   *  event the kernel watcher missed (atomic renames, ignore-rule edits). */
  private readonly reconcileEvery = 50;

  private async sourceRoot(cwd: string): Promise<string | null> {
    const cached = this.rootCache.get(cwd);
    if (cached !== undefined) return cached;
    let root: string | null = null;
    try {
      const result = await run("git", ["rev-parse", "--show-toplevel"], cwd);
      if (result.code === 0) {
        const r = result.stdout.toString("utf8").trim();
        if (r) root = await fsp.realpath(r).catch(() => r);
      }
    } catch {
      root = null;
    }
    this.rootCache.set(cwd, root);
    return root;
  }

  async available(cwd: string): Promise<boolean> {
    return (await this.sourceRoot(cwd)) !== null;
  }

  /** Stop watching all repos. Best-effort; safe to call on shutdown. */
  dispose(): void {
    for (const w of this.watches.values()) {
      try {
        w.watcher?.close();
      } catch {
        // best-effort teardown
      }
    }
    this.watches.clear();
    this.rootCache.clear();
  }

  /** Lazily create (or recover) a recursive worktree watcher for `repo`.
   *  Only worktree paths matter to the snapshot: changes under `.git` (the
   *  index, HEAD) do not alter the worktree tree we capture, and the shadow
   *  object store lives outside the worktree. The watcher therefore ignores
   *  `.git` and the snapshot storage directory, and only ever marks the repo
   *  dirty so the next capture re-enumerates. */
  private ensureWatch(repo: Repository): RepoWatch {
    const id = key(repo.root);
    let w = this.watches.get(id);
    if (w && w.watcher) return w;
    if (!w) {
      w = { watcher: null, dirty: new Set(), pending: new Set(), capturing: false, last: null, root: repo.root, since: 0 };
      this.watches.set(id, w);
    }
    const stateAbs = resolve(this.stateDir);
    try {
      w.watcher = watch(
        repo.root,
        { recursive: true },
        (_event, filename) => {
          const target = w!;
          if (!filename) {
            target.dirty.add("");
            return;
          }
          const abs = resolve(repo.root, filename);
          const rel = relative(repo.root, abs).replaceAll("\\", "/");
          if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
          if (rel === ".git" || rel.startsWith(".git/")) return;
          if (contained(stateAbs, abs)) return;
          (target.capturing ? target.pending : target.dirty).add(rel);
        }
      );
      w.watcher.on("error", () => {
        // The kernel watcher dropped; fall back to a full capture and stop
        // trusting it until the next real capture recreates it.
        try {
          w!.watcher?.close();
        } catch {
          // best-effort teardown
        }
        w!.watcher = null;
        w!.dirty.add("");
      });
    } catch {
      // Watching is unavailable (e.g. too many open files); capture stays
      // correct via the full enumeration path, just never gets the fast path.
      w.watcher = null;
    }
    return w;
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
    // Best-effort seed: copy the source repo's current index into the
    // shadow index so the first normal capture has something to diff against
    // instead of always starting from an empty tree. Linked worktrees are
    // handled by resolving the real index path with Git itself rather than
    // assuming <git-common-dir>/index.
    await this.seedShadowIndex({ root, gitDir }, root).catch(() => undefined);

    return { root, gitDir };
  }

  /** Seed the shadow index from the source worktree's HEAD tree. Uses
   *  `git read-tree` so the shadow index has no stat-cache entries that
   *  would make a noop worktree look like a full diff. Best-effort. */
  private async seedShadowIndex(repo: Repository, sourceRoot: string): Promise<void> {
    const tree = await run("git", ["rev-parse", "--verify", "-q", "HEAD^{tree}"], sourceRoot);
    if (tree.code !== 0) return;
    const treeSha = tree.stdout.toString("utf8").trim();
    if (!/^[0-9a-f]{40,64}$/i.test(treeSha)) return;
    await run(
      "git",
      [
        "-c", "core.autocrlf=false",
        "--git-dir", repo.gitDir,
        "--work-tree", repo.root,
        "read-tree", treeSha,
      ],
      sourceRoot
    );
  }

  private args(repo: Repository, args: string[]): string[] {
    return ["-c", "core.autocrlf=false", "-c", "core.quotepath=false", "--git-dir", repo.gitDir, "--work-tree", repo.root, ...args];
  }

  /** Per-gitDir mutex so concurrent capture / restore / preview calls against
   *  the same shadow repository do not race. Unrelated repos proceed
   *  independently because the key is the shadow directory, not the
   *  instance. */
  private locks = new Map<string, Promise<void>>();

  /** Per-gitDir in-memory cache of which paths the last capture considered
   *  oversized and excluded. Keeps `excluded` truthful across captures even
   *  when no candidate rediscovered an unchanged large file. */
  private exclusionCache = new Map<string, ExclusionMap>();

  private async withRepoLock<T>(gitDir: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(gitDir) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ourChain = prev.then(() => next);
    this.locks.set(gitDir, ourChain);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      // Only drop the map entry if no later caller has chained onto us.
      if (this.locks.get(gitDir) === ourChain) {
        this.locks.delete(gitDir);
      }
    }
  }

  private async loadExclusionState(repo: Repository): Promise<ExclusionMap> {
    const cached = this.exclusionCache.get(repo.gitDir);
    if (cached) return cached;
    const path = join(repo.gitDir, "pideck-exclusions.json");
    try {
      const text = await fsp.readFile(path, "utf8");
      const parsed = JSON.parse(text) as ExclusionMap;
      const map: ExclusionMap = { paths: parsed?.paths ?? {} };
      this.exclusionCache.set(repo.gitDir, map);
      return map;
    } catch {
      const empty: ExclusionMap = { paths: {} };
      this.exclusionCache.set(repo.gitDir, empty);
      return empty;
    }
  }

  private async saveExclusionState(repo: Repository, map: ExclusionMap): Promise<void> {
    this.exclusionCache.set(repo.gitDir, map);
    const path = join(repo.gitDir, "pideck-exclusions.json");
    await fsp.writeFile(path, JSON.stringify({ version: 1, paths: map.paths }), { mode: 0o600 });
  }

  async capture(cwd: string): Promise<SnapshotCapture | null> {
    // Fast path: if a live worktree watcher exists for this repo and has not
    // observed any change since the last capture, return the cached snapshot
    // without spawning git at all. This is what keeps prompt-start latency
    // flat on large repos; the full enumeration below only runs when the
    // worktree actually changed (or every `reconcileEvery` captures).
    //
    // The watcher is eventually-consistent: change events arrive on a later
    // kernel poll, which in normal use has already drained by the time the
    // next turn's capture runs (turns are async). It is only consulted when
    // it is actually attached; if it failed to attach we fall through to a
    // full capture rather than trusting a stale cache.
    const cachedRoot = this.rootCache.get(cwd);
    if (cachedRoot) {
      const w = this.watches.get(key(cachedRoot));
      if (w && w.watcher && w.last && w.last.root === cachedRoot && w.dirty.size === 0 && w.since < this.reconcileEvery) {
        w.since += 1;
        return w.last;
      }
    }
    const result = await this.withRepoLockForCwd(cwd, async () => {
    const repo = await this.repository(cwd);
    if (!repo) return null;
    const w = this.ensureWatch(repo);
    w.capturing = true;
    try {
      const stateRoot = resolve(this.stateDir);
      const isInternal = (candidate: string) => {
        const absolute = resolve(repo.root, candidate);
        const rel = relative(stateRoot, absolute);
        return !rel.startsWith("..") && !isAbsolute(rel);
      };

      // 1. Discover candidates concurrently. `git diff-files` reports
      //    paths in the shadow index whose worktree content differs (or
      //    whose stat data is stale, e.g. right after a fresh seed).
      //    `git ls-files --others` is the untracked set the source repo's
      //    ignore rules already filtered. `git ls-files --deleted` reports
      //    paths in the shadow index that the worktree no longer has.
      //    Finally, `git ls-files --cached` on the *source* repo gives us
      //    the full tracked set; subtracting the shadow's own entries
      //    yields the paths the source has tracked but the shadow has not
      //    yet learned about. Together these commands cover the full
      //    candidate set without ever enumerating the whole tracked
      //    worktree once the shadow is in steady state.
      const [dirtyResult, untrackedResult, deletedResult, shadowResult, sourceCachedResult] = await Promise.all([
        run("git", this.args(repo, ["diff-files", "-z", "--name-only"]), repo.root),
        run("git", ["-c", "core.quotepath=false", "ls-files", "-z", "--others", "--exclude-standard"], repo.root),
        run("git", this.args(repo, ["ls-files", "-z", "--deleted"]), repo.root),
        run("git", this.args(repo, ["ls-files", "-z"]), repo.root),
        run("git", ["-c", "core.quotepath=false", "ls-files", "-z", "--cached"], repo.root),
      ]);
      if (dirtyResult.code !== 0) throw new Error("failed to enumerate dirty snapshot paths");
      if (untrackedResult.code !== 0) throw new Error("failed to enumerate untracked snapshot paths");
      if (deletedResult.code !== 0) throw new Error("failed to enumerate deleted snapshot paths");
      if (shadowResult.code !== 0) throw new Error("failed to read snapshot index");
      if (sourceCachedResult.code !== 0) throw new Error("failed to enumerate source tracked paths");

      const shadowSet = new Set(splitNul(shadowResult.stdout));
      const candidates = new Set<string>();
      for (const path of splitNul(dirtyResult.stdout)) {
        if (!path || isInternal(path)) continue;
        candidates.add(safeRelative(repo.root, path));
      }
      for (const path of splitNul(untrackedResult.stdout)) {
        if (!path || isInternal(path)) continue;
        candidates.add(safeRelative(repo.root, path));
      }
      // Tracked in the source but not yet in the shadow (first capture
      // after init, or after the user `git add`s a new file). We do not
      // add the full source set every capture: only paths the shadow does
      // not already know about become candidates.
      for (const path of splitNul(sourceCachedResult.stdout)) {
        if (!path || isInternal(path)) continue;
        if (shadowSet.has(path)) continue;
        candidates.add(safeRelative(repo.root, path));
      }

      // 2. Reconcile the candidate set against the live worktree, including
      //    re-applying the oversize-file rule and updating the persisted
      //    exclusion map so unchanged-but-excluded paths remain truthful.
      const exclusions = await this.loadExclusionState(repo);
      const liveExcluded: Record<string, { size: number; mtimeMs: number }> = {};
      const finalCandidates: string[] = [];
      for (const rel of candidates) {
        try {
          const stat = await fsp.lstat(join(repo.root, rel));
          if (stat.isFile() && stat.size > MAX_UNTRACKED_BYTES) {
            liveExcluded[rel] = { size: stat.size, mtimeMs: stat.mtimeMs };
            continue;
          }
          finalCandidates.push(rel);
        } catch {
          // A concurrently removed candidate is expressed by `git rm` below
          // (it is in the shadow index but no longer in the worktree); do
          // not stage it and do not keep it in the exclusion set.
        }
      }

      // 3. Compute the set of paths to remove from the shadow index. Only
      //    paths the worktree no longer has should be removed; paths that
      //    are clean against the shadow index stay put. The two
      //    contributing sources are: shadow entries that no longer appear
      //    in the worktree (deleted from the worktree) and shadow entries
      //    that exceed the oversize-file limit (size changed since last
      //    capture).
      const shadowPaths = new Set(splitNul(shadowResult.stdout));
      const deleted = splitNul(deletedResult.stdout);
      const oversizeRemovals: string[] = [];
      for (const shadowPath of shadowPaths) {
        if (exclusions.paths[shadowPath]) {
          // Previously excluded; if it no longer matches the live
          // exclusion entry, drop it from the shadow so the next capture
          // reconsiders it.
          try {
            const stat = await fsp.lstat(join(repo.root, shadowPath));
            if (!stat.isFile() || stat.size <= MAX_UNTRACKED_BYTES) {
              oversizeRemovals.push(shadowPath);
            }
          } catch {
            oversizeRemovals.push(shadowPath);
          }
        }
      }
      const removed = [...new Set([...deleted, ...oversizeRemovals])].filter((path) => !isInternal(path));
      for (const path of removed) {
        if (exclusions.paths[path]) delete exclusions.paths[path];
      }
      for (const path of Object.keys(exclusions.paths)) {
        if (!shadowPaths.has(path)) delete exclusions.paths[path];
      }

      // 4. Apply the candidate set to the shadow index using --sparse so
      //    the rest of the index stays put. We use a NUL-delimited literal
      //    pathspec list scoped to the candidate set, never an unscoped
      //    `git add -A` over the whole worktree.
      if (removed.length) {
        const dropped = await run(
          "git",
          this.args(repo, ["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
          repo.root,
          pathspec(removed.map((p) => safeRelative(repo.root, p)))
        );
        if (dropped.code !== 0) throw new Error("failed to update snapshot index");
      }
      if (finalCandidates.length) {
        const staged = await run(
          "git",
          this.args(repo, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"]),
          repo.root,
          pathspec(finalCandidates.map((p) => safeRelative(repo.root, p)))
        );
        if (staged.code !== 0) throw new Error("failed to capture project snapshot");
      }

      // 5. Persist the merged exclusion map so restarts keep the truth.
      const merged: ExclusionMap = { paths: { ...exclusions.paths, ...liveExcluded } };
      await this.saveExclusionState(repo, merged);

      // 6. Materialize the tree.
      const tree = await run("git", this.args(repo, ["write-tree"]), repo.root);
      if (tree.code !== 0) throw new Error("failed to write project snapshot");
      const hash = tree.stdout.toString("utf8").trim();
      if (!/^[0-9a-f]{40,64}$/i.test(hash)) throw new Error("invalid project snapshot");

      const snapshot: SnapshotCapture = {
        root: repo.root,
        tree: hash,
        excluded: Object.entries(merged.paths).map(([path, info]) => ({
          path,
          size: info.size,
          mtimeMs: info.mtimeMs,
        })),
      };
      w.last = snapshot;
      w.root = repo.root;
      w.dirty = w.pending;
      w.pending = new Set();
      w.since = 0;
      return snapshot;
    } finally {
      w.capturing = false;
    }
    });
    return result;
  }

  /** Resolve the worktree once so the lock key matches the eventual shadow
   *  repository. Falls back to a cwd-based key if not a Git project, in which
   *  case the work inside still fails on `repository()`. */
  private async withRepoLockForCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const root = await this.sourceRoot(cwd);
    const lockKey = root ? join(this.stateDir, key(root)) : `nocwd:${cwd}`;
    return await this.withRepoLock(lockKey, fn);
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

  /** Mark `root`'s cached snapshot stale so the next capture re-enumerates.
   *  Used after operations that write the worktree (restore) so an in-flight
   *  or pending watcher event can never leave a stale snapshot in the cache. */
  private invalidate(root: string): void {
    const w = this.watches.get(key(root));
    if (w) w.dirty.add("");
  }

  async restore(cwd: string, restore: Record<string, string>): Promise<void> {
    const repo = await this.repository(cwd);
    if (!repo) throw new Error("rollback requires a Git project");
    this.invalidate(repo.root);
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
