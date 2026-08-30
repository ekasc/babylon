import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  it("reconverges when a watcher event lands during an authoritative capture", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-snapshot-reconverge-"));
    roots.push(base);
    const root = join(base, "project");
    await mkdir(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "file.txt"), "v1\n");
    await git(root, ["add", "file.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const store = new SnapshotStore(join(base, "state"));
    // Seed the shadow and watch.
    await store.capture(root, { authoritative: true });
    await settle();

    // Mutate the worktree, then capture. During the capture's git
    // invocations, the event loop will run a concurrent writer that
    // creates a new file. The capture must resolve (bounded reconciliation
    // must not loop forever on a quiet repo), and the next capture must
    // reflect the worktree state.
    await writeFile(join(root, "file.txt"), "v2\n");
    const capturePromise = store.capture(root, { authoritative: true });
    // Race a concurrent untracked-file write against the in-flight
    // capture. The capture runs spawn()'d git processes, so the event
    // loop runs and this setTimeout fires during the capture.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await writeFile(join(root, "late.txt"), "late\n");
    const snap = await capturePromise;
    expect(snap).not.toBeNull();

    // The next capture must include the late file (whether the in-flight
    // capture folded it via reconciliation or the next capture picks it
    // up; either way the worktree state is observed).
    await settle();
    const after = await store.capture(root, { authoritative: true });
    expect(after).not.toBeNull();
    // A marker write after the in-flight capture must show up as the only
    // (or at least an) entry in the diff from the in-flight tree. This
    // proves the shadow is healthy and the bounded reconciliation left
    // it in a consistent state.
    await writeFile(join(root, "marker.txt"), "m\n");
    await settle();
    const afterMarker = await store.capture(root, { authoritative: true });
    const diff = await store.changedFiles(root, after!.tree, afterMarker!.tree);
    expect(diff).toContain("marker.txt");
  });
});
