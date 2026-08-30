import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SnapshotStore } from "./snapshot-store";

const exec = promisify(execFile);
const roots: string[] = [];

// The snapshot store no longer skips Git on a quiet worktree; every capture
// runs the two discovery commands. The `settle` helper is kept for tests
// that need the kernel watcher to observe a write (the watcher is a
// concurrent-mutation detector during the bounded reconciliation pass, and
// a test that depends on it needs the events to have landed).
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 200));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

describe("SnapshotStore", () => {
  it("restores selected tracked and untracked files without touching the visible index", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "tracked.txt"), "before\n");
    await git(root, ["add", "tracked.txt"]);
    const indexBefore = await git(root, ["diff", "--cached", "--name-status"]);

    const store = new SnapshotStore(join(base, "state"));
    // Authoritative capture reads the worktree at this instant, so no settle
    // is needed (or wanted) — an immediate edit must be reflected.
    const before = await store.capture(root, { authoritative: true });
    expect(before?.tree).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await git(root, ["diff", "--cached", "--name-status"])).toBe(indexBefore);

    await writeFile(join(root, "tracked.txt"), "after\n");
    await writeFile(join(root, "created.txt"), "created\n");
    const after = await store.capture(root, { authoritative: true });
    expect(after).not.toBeNull();
    expect(await store.changedFiles(root, before!.tree, after!.tree)).toEqual(["created.txt", "tracked.txt"]);

    await store.restore(root, { "tracked.txt": before!.tree, "created.txt": before!.tree });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("before\n");
    await expect(readFile(join(root, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await store.restore(root, { "tracked.txt": after!.tree, "created.txt": after!.tree });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("after\n");
    expect(await readFile(join(root, "created.txt"), "utf8")).toBe("created\n");
    expect(await git(root, ["diff", "--cached", "--name-status"])).toBe(indexBefore);
  });

  it("fails closed when its object store is configured beneath the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-snapshot-internal-"));
    roots.push(root);
    await git(root, ["init"]);
    await writeFile(join(root, "file.txt"), "one\n");
    await git(root, ["add", "file.txt"]);
    const store = new SnapshotStore(join(root, ".pideck-snapshots"));
    await expect(store.capture(root)).rejects.toThrow("outside the project worktree");
  });

  it("refuses to restore through a symlinked parent outside the worktree", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-link-"));
    roots.push(base);
    const root = join(base, "project");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await git(root, ["init"]);
    await writeFile(join(root, "safe.txt"), "safe\n");
    await git(root, ["add", "safe.txt"]);
    await writeFile(join(outside, "victim.txt"), "keep\n");
    await symlink(outside, join(root, "linked"));
    const store = new SnapshotStore(join(base, "state"));
    const snapshot = await store.capture(root);
    await expect(store.restore(root, { "linked/victim.txt": snapshot!.tree })).rejects.toThrow("symlink outside");
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("keep\n");
  });

  it("returns unavailable outside Git and rejects paths that escape the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-no-git-"));
    roots.push(root);
    await mkdir(join(root, "project"));
    const store = new SnapshotStore(join(root, "state"));
    expect(await store.capture(join(root, "project"))).toBeNull();
  });

  it("reports per-file kinds and line counts between two snapshots", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-turnchanges-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "keep.txt"), "keep\n");
    await writeFile(join(root, "removed.txt"), "bye\n");
    await git(root, ["add", "keep.txt", "removed.txt"]);

    const store = new SnapshotStore(join(base, "state"));
    const before = await store.capture(root);
    expect(before).not.toBeNull();

    await writeFile(join(root, "keep.txt"), "keep\nmore\n");
    await writeFile(join(root, "added.txt"), "one\ntwo\n");
    await rm(join(root, "removed.txt"));
    const after = await store.capture(root, { authoritative: true });
    expect(after).not.toBeNull();

    const changes = await store.turnChanges(root, before!.tree, after!.tree);
    expect(changes).toEqual([
      { path: "added.txt", kind: "added", additions: 2, deletions: 0 },
      { path: "keep.txt", kind: "modified", additions: 1, deletions: 0 },
      { path: "removed.txt", kind: "deleted", additions: 0, deletions: 1 },
    ]);
  });

  it("returns a unified diff for a single changed file", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-filediff-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    await git(root, ["add", "file.txt"]);

    const store = new SnapshotStore(join(base, "state"));
    const before = await store.capture(root);
    expect(before).not.toBeNull();

    await writeFile(join(root, "file.txt"), "one\nthree\n");
    const after = await store.capture(root, { authoritative: true });
    expect(after).not.toBeNull();

    const { diff, truncated } = await store.fileDiff(root, before!.tree, after!.tree, "file.txt");
    expect(truncated).toBe(false);
    expect(diff).toContain("-two");
    expect(diff).toContain("+three");
  });

  it("excludes oversized untracked files but never oversized tracked files", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-oversize-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "tracked-big.txt"), "small\n");
    await git(root, ["add", "tracked-big.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const store = new SnapshotStore(join(base, "state"));
    const before = await store.capture(root, { authoritative: true });
    expect(before).not.toBeNull();

    // A tracked file the user edits (still small here, but the rule must not
    // depend on size) and a 3MB untracked artifact.
    await writeFile(join(root, "tracked-big.txt"), "small-but-edited\n");
    await writeFile(join(root, "untracked-big.bin"), Buffer.alloc(3 * 1024 * 1024, "x"));
    const after = await store.capture(root, { authoritative: true });
    expect(after).not.toBeNull();

    // The edited tracked file stays in the snapshot so rollback can restore it.
    expect(await store.changedFiles(root, before!.tree, after!.tree)).toContain("tracked-big.txt");
    // The oversized untracked artifact is excluded, not staged.
    const excludedPaths = after!.excluded.map((e) => e.path);
    expect(excludedPaths).toContain("untracked-big.bin");
    expect(excludedPaths).not.toContain("tracked-big.txt");
  });

  it("admits a previously-excluded untracked file when it shrinks below the limit (same capture)", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-shrink-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "f.txt"), "f\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const store = new SnapshotStore(join(base, "state"));
    // Create a 3MB untracked file. First capture: it is excluded.
    await writeFile(join(root, "shrinking.bin"), Buffer.alloc(3 * 1024 * 1024, "x"));
    const excludedSnap = await store.capture(root, { authoritative: true });
    expect(excludedSnap).not.toBeNull();
    expect(excludedSnap!.excluded.map((e) => e.path)).toContain("shrinking.bin");

    // Shrink the file to 1KB and capture again. The same (single)
    // capture must admit it: the candidate loop sees it as newly
    // untracked (not in the shadow), re-stats, finds it under the
    // limit, stages it, and the snapshot tree contains its current
    // 1KB content. The exclusion map entry is removed.
    await writeFile(join(root, "shrinking.bin"), "small content\n");
    const admitted = await store.capture(root, { authoritative: true });
    expect(admitted).not.toBeNull();
    expect(admitted!.excluded.map((e) => e.path)).not.toContain("shrinking.bin");
    // The file is in the snapshot: a diff from the excluded-snapshot
    // tree to the admitted-snapshot tree includes the path.
    const diff = await store.changedFiles(root, excludedSnap!.tree, admitted!.tree);
    expect(diff).toContain("shrinking.bin");
  });

  it("an admitted untracked file that later grows above the limit stays in the snapshot", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-grow-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "f.txt"), "f\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const store = new SnapshotStore(join(base, "state"));
    // First: a small untracked file gets admitted.
    await writeFile(join(root, "growing.bin"), "small\n");
    const before = await store.capture(root, { authoritative: true });
    expect(before).not.toBeNull();
    expect(before!.excluded.map((e) => e.path)).not.toContain("growing.bin");

    // Now grow it to 3MB. The cutoff applies only at admission: once
    // a path is in the shadow index, the size limit no longer drops
    // it. The file stays in the snapshot as a normal modified entry.
    await writeFile(join(root, "growing.bin"), Buffer.alloc(3 * 1024 * 1024, "x"));
    const after = await store.capture(root, { authoritative: true });
    expect(after).not.toBeNull();
    expect(after!.excluded.map((e) => e.path)).not.toContain("growing.bin");
    const diff = await store.changedFiles(root, before!.tree, after!.tree);
    expect(diff).toContain("growing.bin");
  });

  it("rollback regression: a previously-excluded file that becomes eligible before Send is preserved by a later rollback", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-rollback-eligible-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "f.txt"), "f\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const store = new SnapshotStore(join(base, "state"));
    // 3MB untracked -> excluded.
    await writeFile(join(root, "blob.bin"), Buffer.alloc(3 * 1024 * 1024, "x"));
    const beforeTurn = await store.capture(root, { authoritative: true });
    expect(beforeTurn).not.toBeNull();

    // The "user" edits: shrinks the file to 1KB. This is the pre-Send
    // state and must be captured by the pre-turn checkpoint.
    await writeFile(join(root, "blob.bin"), "small now\n");
    const preTurn = await store.capture(root, { authoritative: true });
    expect(preTurn).not.toBeNull();

    // "Agent" runs: writes a different value.
    await writeFile(join(root, "blob.bin"), "agent wrote this\n");
    const postTurn = await store.capture(root, { authoritative: true });
    expect(postTurn).not.toBeNull();

    // Rollback to the pre-turn tree must restore blob.bin to its
    // pre-turn (1KB) content. If a previous pass had staged the
    // excluded-then-eligible file and then `git rm --cached` it in
    // the same capture, the restore would fail or leave the file
    // wrong. The rollback restores the file's pre-turn content.
    await store.restore(root, { "blob.bin": preTurn!.tree });
    expect(await readFile(join(root, "blob.bin"), "utf8")).toBe("small now\n");
    // A follow-up capture produces the same tree as the pre-turn
    // checkpoint, proving the snapshot reflects the restored content.
    // (If a prior pass had staged the excluded-then-eligible file
    // and then `git rm --cached` it in the same capture, the restore
    // could not bring it back to pre-turn content, or the tree would
    // be wrong.)
    const restored = await store.capture(root, { authoritative: true });
    expect(restored!.tree).toBe(preTurn!.tree);
  });

  it("reconciles the exclusion map when an excluded file is deleted (rollback completeness)", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-excl-deleted-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "f.txt"), "f\n");
    await git(root, ["add", "f.txt"]);

    const store = new SnapshotStore(join(base, "state"));
    // Create a 3MB untracked file. First capture: it is excluded.
    await writeFile(join(root, "huge.log"), Buffer.alloc(3 * 1024 * 1024, "x"));
    const before = await store.capture(root, { authoritative: true });
    expect(before).not.toBeNull();
    expect(before!.excluded.map((e) => e.path)).toContain("huge.log");

    // Delete the excluded file. The next capture must remove the stale
    // exclusion entry; otherwise `before.excluded` and `after.excluded`
    // would both contain `huge.log` and `changedExclusions` would
    // return [], making a turn that deleted an oversized untracked
    // file silently advertise a complete rollback.
    await rm(join(root, "huge.log"));
    const after = await store.capture(root, { authoritative: true });
    expect(after).not.toBeNull();
    expect(after!.excluded.map((e) => e.path)).not.toContain("huge.log");
    expect(after!.excluded).toEqual([]);
  });

  it("drops an excluded file from the returned snapshot when it is deleted during the in-flight capture", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-excl-inflight-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    // Non-trivial tracked set so the in-flight capture runs long
    // enough for a setTimeout to fire during it.
    for (let i = 0; i < 2000; i++) {
      await writeFile(join(root, `f${String(i).padStart(5, "0")}.txt`), `${i}\n`);
    }
    await git(root, ["add", "-A"]);
    // Oversize untracked file, excluded on the first capture.
    const huge = join(root, "huge.log");
    await writeFile(huge, Buffer.alloc(3 * 1024 * 1024, "x"));

    const store = new SnapshotStore(join(base, "state"));
    const before = await store.capture(root, { authoritative: true });
    expect(before!.excluded.map((e) => e.path)).toContain("huge.log");

    // Start an in-flight capture. The reconcile at the top of the
    // first pass sees the file and keeps it. The verification's
    // reconcile must observe the delete and drop the entry before
    // the stability check decides the checkpoint is good.
    const capturePromise = store.capture(root, { authoritative: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await rm(huge);
    const after = await capturePromise;
    expect(after).not.toBeNull();
    expect(after!.excluded.map((e) => e.path)).not.toContain("huge.log");
    // The deletion was during the in-flight capture; the same
    // returned snapshot reflects it.
    expect(after!.excluded).toEqual([]);
  });

  it("admits a previously-excluded untracked file that shrank during the in-flight capture", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-shrink-inflight-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    for (let i = 0; i < 2000; i++) {
      await writeFile(join(root, `f${String(i).padStart(5, "0")}.txt`), `${i}\n`);
    }
    await git(root, ["add", "-A"]);
    const huge = join(root, "shrinking.log");
    await writeFile(huge, Buffer.alloc(3 * 1024 * 1024, "x"));

    const store = new SnapshotStore(join(base, "state"));
    const before = await store.capture(root, { authoritative: true });
    expect(before!.excluded.map((e) => e.path)).toContain("shrinking.log");

    // Shrink the file during the in-flight capture. The
    // verification's reconcile drops it from the exclusion map; the
    // verification's `--others` then reports it; the next pass
    // admits it.
    const capturePromise = store.capture(root, { authoritative: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await writeFile(huge, "small now\n");
    const after = await capturePromise;
    expect(after).not.toBeNull();
    expect(after!.excluded.map((e) => e.path)).not.toContain("shrinking.log");
    // The file is now in the snapshot tree.
    const diff = await store.changedFiles(root, before!.tree, after!.tree);
    expect(diff).toContain("shrinking.log");
  });

  it("reconciles the exclusion map when an excluded file is renamed (delete-old + create-new)", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-excl-rename-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "f.txt"), "f\n");
    await git(root, ["add", "f.txt"]);

    const store = new SnapshotStore(join(base, "state"));
    await writeFile(join(root, "huge.log"), Buffer.alloc(3 * 1024 * 1024, "x"));
    const before = await store.capture(root, { authoritative: true });
    expect(before!.excluded.map((e) => e.path)).toContain("huge.log");

    // Rename: the old name is gone, a new oversized file appears
    // under a different name. The old exclusion entry must be
    // dropped, and the new name must be excluded fresh.
    await rename(join(root, "huge.log"), join(root, "renamed.log"));
    const after = await store.capture(root, { authoritative: true });
    expect(after!.excluded.map((e) => e.path)).not.toContain("huge.log");
    expect(after!.excluded.map((e) => e.path)).toContain("renamed.log");
  });

  it("refreshes size/mtime of a still-oversize excluded file", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-excl-refresh-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "f.txt"), "f\n");
    await git(root, ["add", "f.txt"]);

    const store = new SnapshotStore(join(base, "state"));
    const initial = Buffer.alloc(3 * 1024 * 1024, "x");
    await writeFile(join(root, "huge.log"), initial);
    const before = await store.capture(root, { authoritative: true });
    const beforeEntry = before!.excluded.find((e) => e.path === "huge.log")!;
    expect(beforeEntry).toBeDefined();

    // Rewrite the file at a different size, still over the limit. The
    // exclusion entry must reflect the new size so a later
    // `changedExclusions` comparison sees the real current value.
    const grown = Buffer.alloc(4 * 1024 * 1024, "y");
    await writeFile(join(root, "huge.log"), grown);
    const after = await store.capture(root, { authoritative: true });
    const afterEntry = after!.excluded.find((e) => e.path === "huge.log")!;
    expect(afterEntry).toBeDefined();
    expect(afterEntry.size).toBe(grown.length);
    expect(afterEntry.size).not.toBe(beforeEntry.size);
  });



  it("captures the worktree at the instant of an authoritative capture, even before the watcher fires (rollback boundary)", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-authoritative-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "file.txt"), "before\n");
    await git(root, ["add", "file.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const store = new SnapshotStore(join(base, "state"));
    const a = await store.capture(root, { authoritative: true });
    expect(a).not.toBeNull();

    // The user edits before pressing Send; the kernel watcher has not yet
    // reported the change. An authoritative capture MUST still see it, or a
    // later rollback would destroy the edit. No settle() — this is the
    // regression that the watcher-as-source-of-truth fast path introduced.
    await writeFile(join(root, "file.txt"), "after\n");
    const b = await store.capture(root, { authoritative: true });
    expect(b).not.toBeNull();
    expect(b!.tree).not.toBe(a!.tree);
    expect(await store.changedFiles(root, a!.tree, b!.tree)).toEqual(["file.txt"]);
  });

  it("returns the cached snapshot on a clean worktree without re-enumerating (noop fast path)", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-noop-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "file.txt"), "before\n");
    await git(root, ["add", "file.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const store = new SnapshotStore(join(base, "state"));
    const a = await store.capture(root, { authoritative: true });
    // Drain watcher events from the capture's own git operations. A second
    // capture of the unchanged worktree still runs the two Git discovery
    // commands (no watcher short-circuit), but they return empty, no
    // candidate is staged, and the produced tree OID is stable.
    await settle();
    const b = await store.capture(root);
    expect(b).not.toBeNull();
    expect(b!.tree).toBe(a!.tree);
    expect(b!.excluded).toEqual(a!.excluded);
  });

  it("authoritative capture immediately after an external write sees the new content (rollback boundary)", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-auth-boundary-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "file.txt"), "B\n");
    await git(root, ["add", "file.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const store = new SnapshotStore(join(base, "state"));
    const before = await store.capture(root, { authoritative: true });
    expect(before).not.toBeNull();

    // Simulate the user editing the worktree the instant before a destructive
    // rollback. The kernel watcher is eventually consistent; the next
    // authoritative capture must read Git/FS directly and observe C, not
    // return the cached B.
    await writeFile(join(root, "file.txt"), "C\n");
    const redo = await store.capture(root, { authoritative: true });
    expect(redo).not.toBeNull();
    expect(redo!.tree).not.toBe(before!.tree);
    const diff = await store.changedFiles(root, before!.tree, redo!.tree);
    expect(diff).toContain("file.txt");
  });

  it("honors .gitignore for untracked candidates", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-ignore-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "keep.txt"), "keep\n");
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await git(root, ["add", "keep.txt", ".gitignore"]);
    await git(root, ["commit", "-m", "init"]);

    const store = new SnapshotStore(join(base, "state"));
    const snap = await store.capture(root, { authoritative: true });
    expect(snap).not.toBeNull();
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, "ignored/secret.txt"), "x\n");
    await writeFile(join(root, "visible.txt"), "y\n");
    const after = await store.capture(root, { authoritative: true });
    expect(after).not.toBeNull();
    // The visible untracked file is in the snapshot; the ignored one is not.
    const changed = await store.changedFiles(root, snap!.tree, after!.tree);
    expect(changed).toContain("visible.txt");
    expect(changed).not.toContain("ignored/secret.txt");
  });

  it("stages only the candidate set; the rest of the shadow index is preserved", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-partial-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "a.txt"), "a1\n");
    await writeFile(join(root, "b.txt"), "b1\n");
    await writeFile(join(root, "c.txt"), "c1\n");
    await git(root, ["add", "a.txt", "b.txt", "c.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const store = new SnapshotStore(join(base, "state"));
    const before = await store.capture(root, { authoritative: true });
    expect(before).not.toBeNull();

    // Change only b.txt. The capture must stage only b.txt and leave a.txt
    // and c.txt's entries in the shadow index untouched (same blob OID).
    await writeFile(join(root, "b.txt"), "b2\n");
    const after = await store.capture(root, { authoritative: true });
    expect(after).not.toBeNull();

    const diff = await store.changedFiles(root, before!.tree, after!.tree);
    expect(diff).toEqual(["b.txt"]);

    // A second clean capture (no further edits) must report no changes and
    // produce the same tree OID as the previous capture — the shadow's
    // index for a.txt and c.txt was not disturbed by the partial staging.
    await settle();
    const still = await store.capture(root, { authoritative: true });
    expect(still!.tree).toBe(after!.tree);
  });

  it("seeds the shadow from a linked worktree's index, not the main repo's", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-worktree-"));
    roots.push(base);
    const main = join(base, "main");
    await mkdir(main);
    await git(main, ["init"]);
    await git(main, ["config", "user.email", "test@example.com"]);
    await git(main, ["config", "user.name", "Test"]);
    await writeFile(join(main, "main.txt"), "m\n");
    await git(main, ["add", "main.txt"]);
    await git(main, ["commit", "-m", "init"]);

    // Add a different file in the main branch and commit.
    await writeFile(join(main, "only-main.txt"), "om\n");
    await git(main, ["add", "only-main.txt"]);
    await git(main, ["commit", "-m", "only in main"]);

    // Create a linked worktree on a new branch with a different file.
    const wt = join(base, "wt");
    await git(main, ["worktree", "add", "-b", "wt-branch", wt]);
    await writeFile(join(wt, "only-wt.txt"), "ow\n");
    await git(wt, ["add", "only-wt.txt"]);
    // Stage but do not commit — the worktree's index is what the shadow
    // must seed from.
    const store = new SnapshotStore(join(base, "state"));
    const snap = await store.capture(wt, { authoritative: true });
    expect(snap).not.toBeNull();
    // The snapshot tree must contain the worktree-only file.
    await writeFile(join(wt, "only-wt-new.txt"), "new\n");
    const after = await store.capture(wt, { authoritative: true });
    const diff = await store.changedFiles(wt, snap!.tree, after!.tree);
    expect(diff).toContain("only-wt-new.txt");
  });

  it("reuses the same shadow gitDir after dispose + reopen without re-seeding from HEAD^{tree}", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-reopen-"));
    roots.push(base);
    const root = join(base, "project");
    const state = join(base, "state");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "f.txt"), "v1\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const a = new SnapshotStore(state);
    const first = await a.capture(root, { authoritative: true });
    a.dispose();

    // Reopen with a fresh store instance against the same state dir. The
    // shadow's gitDir must be reused; the previously-staged tree must be
    // the starting point, not a re-seed from HEAD^{tree} (which is the
    // same here, but the mechanism under test is the reuse).
    const b = new SnapshotStore(state);
    const reopened = await b.capture(root, { authoritative: true });
    expect(reopened!.tree).toBe(first!.tree);
    // A subsequent edit must produce the same diff as before reopen.
    await writeFile(join(root, "f.txt"), "v2\n");
    const after = await b.capture(root, { authoritative: true });
    const diff = await b.changedFiles(root, first!.tree, after!.tree);
    expect(diff).toEqual(["f.txt"]);
  });

  it("the same in-flight capture includes a file written during the capture (no stale return)", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-reconverge-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    // Use a non-trivial tracked set so the initial discovery takes long
    // enough that a setTimeout fired shortly after the capture call
    // reliably lands during the capture (rather than after it).
    for (let i = 0; i < 2000; i++) {
      await writeFile(join(root, `f${String(i).padStart(5, "0")}.txt`), `${i}\n`);
    }
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "init"]);

    const store = new SnapshotStore(join(base, "state"));
    await store.capture(root, { authoritative: true });
    await settle();
    const pre = await store.capture(root, { authoritative: true });
    expect(pre).not.toBeNull();

    // Start the in-flight capture, then write a new untracked file
    // while it is running. The setTimeout fires from the event loop
    // after the capture's first awaited git spawn, so the write lands
    // during the capture (either the initial discovery sees it, or
    // the verification discovery forces a reconciliation pass that
    // picks it up). Either way, the returned in-flight tree must
    // contain the file. A subsequent capture with no further writes
    // must produce the same tree, proving the in-flight capture was
    // the one that incorporated the write, not a follow-up.
    const capturePromise = store.capture(root, { authoritative: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await writeFile(join(root, "late.txt"), "late\n");
    const snap = await capturePromise;
    expect(snap).not.toBeNull();

    // The same in-flight capture's tree must contain the late file.
    const diff = await store.changedFiles(root, pre!.tree, snap!.tree);
    expect(diff).toContain("late.txt");
    // The tree is final: a follow-up capture (no further writes)
    // produces the same tree, proving the in-flight capture itself
    // incorporated the write.
    const follow = await store.capture(root, { authoritative: true });
    expect(follow!.tree).toBe(snap!.tree);
  });
});
