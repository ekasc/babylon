import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitInfo, gitStatus, invalidateGitStatus } from "./git-status";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function makeRepoWithCommit(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pideck-gitstatus-"));
  roots.push(base);
  const root = join(base, "project");
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "file.txt"), "one\n");
  await git(root, ["add", "file.txt"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

describe("gitStatus result cache", () => {
  it("reports branch and root from a single combined rev-parse", async () => {
    const root = await makeRepoWithCommit();
    const info = await gitInfo(root);
    expect(info).toMatchObject({ isRepo: true, branch: "main", root: await realpath(root) });
    expect(info.isLinkedWorktree).toBe(false);
  });

  it("serves rapid refires from cache until invalidated", async () => {
    const root = await makeRepoWithCommit();
    const first = await gitStatus(root);
    expect(first.isRepo).toBe(true);
    expect(first.dirty).toEqual([]);

    // Working tree changed, but the cached pass still reports clean: this is
    // the behavior that collapses the per-emission spawn bursts.
    await writeFile(join(root, "new.txt"), "hello\n");
    const stale = await gitStatus(root);
    expect(stale.dirty).toEqual([]);

    invalidateGitStatus(root);
    const fresh = await gitStatus(root);
    expect(fresh.dirty.map((f) => f.path)).toEqual(["new.txt"]);
  });

  it("shares one computation across concurrent callers", async () => {
    const root = await makeRepoWithCommit();
    const [a, b, c] = await Promise.all([gitStatus(root), gitStatus(root), gitStatus(root)]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toMatchObject({ isRepo: true, branch: "main" });
  });

  it("reports non-repositories without throwing", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-gitstatus-norepo-"));
    roots.push(base);
    const result = await gitStatus(base);
    expect(result).toEqual({ isRepo: false, dirty: [], ahead: 0, behind: 0 });
  });
});
