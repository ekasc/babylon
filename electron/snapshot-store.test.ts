import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SnapshotStore } from "./snapshot-store";

const exec = promisify(execFile);
const roots: string[] = [];

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
    const before = await store.capture(root);
    expect(before?.tree).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await git(root, ["diff", "--cached", "--name-status"])).toBe(indexBefore);

    await writeFile(join(root, "tracked.txt"), "after\n");
    await writeFile(join(root, "created.txt"), "created\n");
    const after = await store.capture(root);
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
});
