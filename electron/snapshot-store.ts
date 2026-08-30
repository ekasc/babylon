import { createHash } from "node:crypto";
import { promises as fsp, watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_BYTES = 200 * 1024;
const GIT_TIMEOUT_MS = 120_000;
/** Bounded reconciliation passes. If the worktree mutates continuously
 *  (a build writing files in a loop, a `git clean` in progress, etc.) the
 *  capture refuses to return rather than pretending a stable checkpoint was
 *  reached. Three passes is enough to clear ordinary concurrent edits. */
const MAX_RECONCILE_PASSES = 3;

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
  /** Paths the kernel reported as changed since the last completed pass. An
   *  empty string is a sentinel meaning "assume the whole repo changed". */
  dirty: Set<string>;
  /** Changes observed while a capture was in flight; merged into `dirty` so
   *  a concurrent edit is never lost. */
  pending: Set<string>;
  capturing: boolean;
  /** Last fully-computed snapshot. Returned verbatim when a capture's
   *  authoritative candidate discovery finds no changes. */
  last: SnapshotCapture | null;
  root: string;
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

  /** Per-repo worktree watchers. The watcher is a concurrent-mutation
   *  detector only: it does not feed a fast path. Every capture runs the
   *  authoritative Git candidate discovery; the watcher exists to force an
   *  additional reconciliation pass if a write lands during the capture. */
  private watches = new Map<string, RepoWatch>();

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
   *  dirty so the next reconciliation pass is forced. */
  private ensureWatch(repo: Repository): RepoWatch {
    const id = key(repo.root);
    let w = this.watches.get(id);
    if (w && w.watcher) return w;
    if (!w) {
      w = { watcher: null, dirty: new Set(), pending: new Set(), capturing: false, last: null, root: repo.root };
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
        // The kernel watcher dropped. Mark everything dirty so the next
        // capture runs the full reconciliation; the next capture will also
        // try to reattach the watcher.
        try {
          w!.watcher?.close();
        } catch {
          // best-effort teardown
        }
        w!.watcher = null;
        w!.dirty.add("");
      });
    } catch {
      // Watching is unavailable; capture stays correct via the candidate
      // discovery, it just never gets to merge a concurrent write into the
      // current pass.
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
        ["core.untrackedCache", "true"],
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
      // One-time shadow initialization: copy the source's active index into
      // the shadow gitDir so the shadow starts life in lock-step with the
      // worktree. The source index's path must be resolved for the current
      // cwd because linked worktrees do not share the main repository's
      // `.git/index` file. After this point the shadow index evolves
      // incrementally through `git add`/`git rm --cached` and is never reset.
      await this.initShadowIndex({ root, gitDir }, root).catch(() => undefined);
    }

    return { root, gitDir };
  }

  /** Initialize the shadow index from the source's active index and sync
   *  the source's per-repo exclude file into the shadow. Runs once per
   *  shadow gitDir, at creation time. Best-effort: an unborn-HEAD repo
   *  or an unreadable source index leaves the shadow index empty, and the
   *  first capture will discover the whole worktree as untracked.
   *
   *  Because the shadow is a separate gitDir outside the worktree, its
   *  `ls-files --others --exclude-standard` reads the worktree's
   *  `.gitignore` but does NOT see the source's `<git-dir>/info/exclude`
   *  (the per-source-repo exclude file). Sync that file so the shadow's
   *  untracked discovery honors the same excludes the source does. The
   *  global `core.excludesFile` is read by git regardless of --git-dir,
   *  so it needs no sync. */
  private async initShadowIndex(repo: Repository, sourceRoot: string): Promise<void> {
    const idxPath = await run("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], sourceRoot);
    if (idxPath.code === 0) {
      const sourceIndex = idxPath.stdout.toString("utf8").trim();
      if (sourceIndex) {
        try {
          const data = await fsp.readFile(sourceIndex);
          await fsp.writeFile(join(repo.gitDir, "index"), data, { mode: 0o600 });
        } catch {
          // Best-effort.
        }
      }
    }
    const excludePath = await run("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], sourceRoot);
    if (excludePath.code === 0) {
      const sourceExclude = excludePath.stdout.toString("utf8").trim();
      if (sourceExclude) {
        try {
          const data = await fsp.readFile(sourceExclude);
          await fsp.mkdir(join(repo.gitDir, "info"), { recursive: true, mode: 0o700 });
          await fsp.writeFile(join(repo.gitDir, "info", "exclude"), data, { mode: 0o600 });
        } catch {
          // No source exclude file or unreadable; the shadow's
          // info/exclude is left absent (git treats an absent file as
          // "no excludes"), which is the correct safe default.
        }
      }
    }
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

  /** Reconcile the persisted exclusion map against the live worktree.
   *  A path recorded as excluded may have been deleted since the last
   *  capture. If the stale entry survived, the before/after
   *  `excluded` lists would be identical and a turn that deleted an
   *  oversized untracked file would advertise a complete rollback
   *  even though the file cannot be restored. ENOENT removes the
   *  entry. A still-oversize file has its size/mtime refreshed so the
   *  next `changedExclusions` comparison sees the current value. A
   *  present-but-no-longer-oversize file is left in the map: the
   *  candidate loop will report it as newly untracked in this same
   *  capture and admit it. */
  private async reconcileExclusions(repo: Repository, map: ExclusionMap): Promise<void> {
    for (const rel of Object.keys(map.paths)) {
      let stat;
      try {
        stat = await fsp.lstat(join(repo.root, rel));
      } catch {
        // Unreadable or vanished since the last capture.
        delete map.paths[rel];
        continue;
      }
      if (stat.isFile() && stat.size > MAX_UNTRACKED_BYTES) {
        map.paths[rel] = { size: stat.size, mtimeMs: stat.mtimeMs };
      } else {
        // Shrunk below the limit, replaced by a directory or
        // symlink, or otherwise no longer a regular file over the
        // limit. Drop the entry; the candidate loop on the next pass
        // (or the verification's `--others` filter on this pass)
        // will classify the path as a normal candidate.
        delete map.paths[rel];
      }
    }
  }

  async capture(cwd: string, opts?: { authoritative?: boolean }): Promise<SnapshotCapture | null> {
    const result = await this.withRepoLockForCwd(cwd, async () => {
      const repo = await this.repository(cwd);
      if (!repo) return null;
      const w = this.ensureWatch(repo);
      w.capturing = true;
      try {
        return await this.captureInner(repo, w);
      } finally {
        w.capturing = false;
      }
    });
    return result;
  }

  /** Inner capture loop. The lock and `capturing` flag are managed by the
   *  outer `capture`. Each pass does:
   *    1. Authoritative candidate discovery against the shadow index
   *       (concurrent `git diff-files` + `git ls-files --others`).
   *    2. Candidate-only oversize policy + staging via candidate-scoped
   *       `git add -A`, then `git write-tree`.
   *    3. A second authoritative discovery. If empty, the checkpoint is
   *       stable and we return. If non-empty, a concurrent write
   *       happened during the pass — reconcile again.
   *  Bounded by `MAX_RECONCILE_PASSES`. The watcher may force an early
   *  retry, but it is never proof of stability. The only proof is the
   *  second discovery coming back empty. */
  private async captureInner(repo: Repository, w: RepoWatch): Promise<SnapshotCapture | null> {
    const stateRoot = resolve(this.stateDir);
    const isInternal = (candidate: string) => {
      const absolute = resolve(repo.root, candidate);
      const rel = relative(stateRoot, absolute);
      return !rel.startsWith("..") && !isAbsolute(rel);
    };

    const exclusions = await this.loadExclusionState(repo);
    // Reconcile the persisted exclusion map against the live worktree
    // once per capture. A path recorded as excluded may have been
    // deleted since the last capture; if the stale entry survived,
    // `before.excluded` and `after.excluded` would both contain the
    // path, `changedExclusions` would return [], and a turn that
    // deleted an oversized untracked file would be advertised as
    // having a complete rollback. ENOENT removes the entry. A
    // still-oversize file has its size/mtime refreshed so the next
    // `changedExclusions` comparison sees the current value.
    await this.reconcileExclusions(repo, exclusions);

    for (let pass = 0; pass < MAX_RECONCILE_PASSES; pass++) {
      // At pass start, merge any events the watcher buffered (w.pending)
      // into the dirty set, then clear both. This guarantees the next
      // pass's discovery sees them, and prevents the pass from
      // returning "stable" while a mutation is still queued in
      // pending.
      for (const pending of w.pending) w.dirty.add(pending);
      w.pending.clear();
      const dirtySeen = new Set(w.dirty);
      w.dirty.clear();

      // 1. Authoritative candidate discovery against the SHADOW index.
      //    `git diff-files` and `git ls-files --others` both run on the
      //    shadow (--git-dir = shadow gitDir, --work-tree = project
      //    root), so the shadow's tracked set is the reference. A file
      //    Babylon has already admitted into the shadow stops being
      //    "untracked" on subsequent captures — the persistent
      //    incremental model. `--exclude-standard` still honors
      //    .gitignore files in the worktree because they are
      //    worktree-relative.
      const [dirtyResult, untrackedResult] = await Promise.all([
        run("git", this.args(repo, ["diff-files", "-z", "--name-only"]), repo.root),
        run("git", this.args(repo, ["ls-files", "-z", "--others", "--exclude-standard"]), repo.root),
      ]);
      if (dirtyResult.code !== 0) throw new Error("failed to enumerate dirty snapshot paths");
      if (untrackedResult.code !== 0) throw new Error("failed to enumerate untracked snapshot paths");

      // 2. Union candidates. Tracked-mod/del from diff-files, untracked
      //    from ls-files --others.
      const candidates = new Set<string>();
      const untracked = new Set<string>();
      for (const path of splitNul(dirtyResult.stdout)) {
        if (!path || isInternal(path)) continue;
        candidates.add(safeRelative(repo.root, path));
      }
      for (const path of splitNul(untrackedResult.stdout)) {
        if (!path || isInternal(path)) continue;
        const rel = safeRelative(repo.root, path);
        candidates.add(rel);
        untracked.add(rel);
      }

      // 3. Apply the oversize-file policy. The cutoff applies only at
      //    admission: a path newly untracked relative to the shadow is
      //    excluded if oversize; once admitted, the path is shadow-
      //    tracked and the cutoff no longer applies. A previously-
      //    excluded path that has shrunk below the limit will appear
      //    here as newly untracked, and the candidate loop will admit
      //    it on this pass. A previously-excluded path still in the
      //    exclusion map stays excluded if it is still oversize or
      //    gone. `exclusions.paths` is the single source of truth
      //    during the pass; the verification below filters the
      //    `--others` result against its keys.
      const finalCandidates: string[] = [];
      for (const rel of candidates) {
        try {
          const stat = await fsp.lstat(join(repo.root, rel));
          if (untracked.has(rel) && stat.isFile() && stat.size > MAX_UNTRACKED_BYTES) {
            exclusions.paths[rel] = { size: stat.size, mtimeMs: stat.mtimeMs };
            continue;
          }
          // Eligible (or shadow-tracked and modified) — stage it. If it
          // was previously excluded, drop it from the exclusion map.
          delete exclusions.paths[rel];
          finalCandidates.push(rel);
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
          // The candidate no longer exists. diff-files entries here are
          // deletions (stage the removal); --others entries are raced
          // deletes of untracked files (nothing to stage).
          if (!untracked.has(rel)) {
            delete exclusions.paths[rel];
            finalCandidates.push(rel);
          }
        }
      }

      // 4. Stage the candidate set with git add -A (modifications,
      //    deletions, additions) scoped to the candidate pathspec.
      if (finalCandidates.length) {
        const staged = await run(
          "git",
          this.args(repo, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"]),
          repo.root,
          pathspec(finalCandidates)
        );
        if (staged.code !== 0) throw new Error("failed to capture project snapshot");
      }

      // 5. Materialize the tree.
      const tree = await run("git", this.args(repo, ["write-tree"]), repo.root);
      if (tree.code !== 0) throw new Error("failed to write project snapshot");
      const hash = tree.stdout.toString("utf8").trim();
      if (!/^[0-9a-f]{40,64}$/i.test(hash)) throw new Error("invalid project snapshot");

      // 6. Verification discovery. Re-run the same two commands against
      //    the just-updated shadow index. If a concurrent write landed
      //    during the pass, the second discovery will see it. If the
      //    second discovery is empty, the checkpoint is stable.
      //    Watcher delivery is not consulted here — the verification
      //    is the only proof of stability. The `--others` result is
      //    filtered against the exclusion map: an excluded file is a
      //    known exclusion, not a concurrent write, and must not
      //    force an unnecessary retry.
      //
      //    Reconcile the exclusion map again first: a delete or
      //    shrink that landed during this in-flight capture must be
      //    reflected in the returned snapshot, not deferred to the
      //    next one. Without this re-reconcile, the stability check
      //    can succeed against stale exclusion metadata and the
      //    caller receives a snapshot whose `excluded` list still
      //    names a path the worktree no longer has.
      await this.reconcileExclusions(repo, exclusions);
      const [vDirty, vUntracked] = await Promise.all([
        run("git", this.args(repo, ["diff-files", "-z", "--name-only"]), repo.root),
        run("git", this.args(repo, ["ls-files", "-z", "--others", "--exclude-standard"]), repo.root),
      ]);
      if (vDirty.code !== 0) throw new Error("failed to verify snapshot stability");
      if (vUntracked.code !== 0) throw new Error("failed to verify snapshot stability");
      const verifyDirty = splitNul(vDirty.stdout);
      const verifyUntracked = splitNul(vUntracked.stdout).filter((p) => !(p in exclusions.paths));
      if (verifyDirty.length === 0 && verifyUntracked.length === 0) {
        // Stable checkpoint. Persist the merged exclusion map and
        // return. The exclusion map may still contain entries for
        // paths that are oversize-or-gone; that is correct.
        await this.saveExclusionState(repo, exclusions);
        const snapshot: SnapshotCapture = {
          root: repo.root,
          tree: hash,
          excluded: Object.entries(exclusions.paths).map(([path, info]) => ({
            path,
            size: info.size,
            mtimeMs: info.mtimeMs,
          })),
        };
        w.last = snapshot;
        w.root = repo.root;
        w.dirty.clear();
        w.pending.clear();
        return snapshot;
      }
      // The verification saw a concurrent write. The next pass's
      // discovery will pick it up. The watcher may also have buffered
      // events; both will be merged at the top of the next pass.
    }
    // Failed to converge. The worktree is mutating faster than we can
    // reconcile. Refuse to return a potentially-stale snapshot.
    throw new Error("project snapshot could not reach a stable checkpoint; the worktree is mutating continuously");
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
    // Restore mutates the shadow index (git checkout writes into it), so it
    // must run under the same per-repo lock as capture to avoid racing a
    // concurrent staging operation.
    await this.withRepoLockForCwd(cwd, async () => {
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
    });
  }
}
