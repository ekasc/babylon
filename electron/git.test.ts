import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  commitAll,
  commitStaged,
  createBranch,
  prepareCommitContext,
  detectProviderFromRemoteUrl,
  listBranches,
  pullCurrentBranch,
  pushCurrentBranch,
  resetStaged,
  statusDetails,
  suggestPrContent,
  switchBranch,
  validateBranchName,
} from "./git";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function makeRepo(name = "project"): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pideck-git-"));
  roots.push(base);
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  return root;
}

async function makeRepoWithCommit(): Promise<string> {
  const root = await makeRepo();
  await writeFile(join(root, "file.txt"), "one\n");
  await git(root, ["add", "file.txt"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

describe("statusDetails", () => {
  it("reports non-repositories", async () => {
    const base = await mkdtemp(join(tmpdir(), "pideck-git-norepo-"));
    roots.push(base);
    const details = await statusDetails(base);
    expect(details.isRepo).toBe(false);
  });

  it("reports a clean repo on its default branch", async () => {
    const root = await makeRepoWithCommit();
    const details = await statusDetails(root);
    expect(details.isRepo).toBe(true);
    expect(details.branch).toBe("main");
    expect(details.isDefaultBranch).toBe(true);
    expect(details.hasChanges).toBe(false);
    expect(details.files).toEqual([]);
    expect(details.ahead).toBe(0);
    expect(details.behind).toBe(0);
  });

  it("lists changed files with insertion and deletion counts", async () => {
    const root = await makeRepoWithCommit();
    await writeFile(join(root, "file.txt"), "one\ntwo\nthree\n");
    await writeFile(join(root, "new.txt"), "hello\n");
    const details = await statusDetails(root);
    expect(details.hasChanges).toBe(true);
    expect(details.files.map((f) => f.path)).toEqual(["file.txt", "new.txt"]);
    expect(details.files[0]).toMatchObject({ insertions: 2, deletions: 0 });
    expect(details.files[1]).toMatchObject({ insertions: 1, deletions: 0, status: "?" });
    expect(details.insertions).toBe(3);
  });

  it("excludes ignored files and expands visible untracked directories", async () => {
    const root = await makeRepoWithCommit();
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await mkdir(join(root, "ignored"));
    await mkdir(join(root, "visible"));
    await writeFile(join(root, "ignored", "secret.txt"), "ignored\n");
    await writeFile(join(root, "visible", "new.txt"), "one\ntwo\n");

    const details = await statusDetails(root);
    expect(details.files.map((file) => file.path)).toContain("visible/new.txt");
    expect(details.files.map((file) => file.path)).not.toContain("ignored/secret.txt");
    expect(details.files.find((file) => file.path === "visible/new.txt")).toMatchObject({ insertions: 2, status: "?" });
  });

  it("prepares staged context that includes untracked file contents", async () => {
    const root = await makeRepoWithCommit();
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    await writeFile(join(root, "new.txt"), "new content\n");

    const context = await prepareCommitContext(root);
    expect(context.stagedSummary).toContain("file.txt");
    expect(context.stagedSummary).toContain("new.txt");
    expect(context.stagedPatch).toContain("+two");
    expect(context.stagedPatch).toContain("+new content");
    expect(context.recentSubjects).toContain("initial");
    await expect(commitStaged(root, "Add prepared context test")).resolves.toMatchObject({ subject: "Add prepared context test" });
  });

  it("marks large staged changes as requiring a body", async () => {
    const root = await makeRepoWithCommit();
    await writeFile(join(root, "large.txt"), `${Array.from({ length: 501 }, (_, index) => `line ${index}`).join("\n")}\n`);
    expect((await prepareCommitContext(root)).requiresBody).toBe(true);
  });

  it("counts unpushed commits against the default branch", async () => {
    const root = await makeRepoWithCommit();
    await git(root, ["checkout", "-b", "feature"]);
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    await git(root, ["add", "file.txt"]);
    await git(root, ["commit", "-m", "feature work"]);
    const details = await statusDetails(root);
    expect(details.branch).toBe("feature");
    expect(details.isDefaultBranch).toBe(false);
    expect(details.ahead).toBe(1);
    expect(details.aheadOfDefault).toBe(1);
  });

  it("handles unborn HEAD with staged files", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "file.txt"), "one\n");
    await git(root, ["add", "file.txt"]);
    const details = await statusDetails(root);
    expect(details.isRepo).toBe(true);
    expect(details.hasChanges).toBe(true);
    expect(details.files.map((f) => f.path)).toContain("file.txt");
    expect(details.insertions).toBe(1);
  });
});

describe("resetStaged", () => {
  it("preserves both the staged diff and unstaged working-tree edits when generation fails", async () => {
    const root = await makeRepoWithCommit();
    // 1. partially stage file.ts: index has 2 lines, HEAD has 1
    await writeFile(join(root, "file.ts"), "one\ntwo\n");
    await git(root, ["add", "file.ts"]);
    // 2. make additional unstaged edits on top of the staged set
    await writeFile(join(root, "file.ts"), "one\ntwo\nthree\n");

    const stagedBefore = await git(root, ["diff", "--cached", "file.ts"]);
    const workingBefore = await git(root, ["diff", "file.ts"]);
    const fileBefore = await readFile(join(root, "file.ts"), "utf8");

    const context = await prepareCommitContext(root);
    // Sanity: prepareCommitContext ran git add -A, so the working-tree diff
    // should now be empty.
    expect(await git(root, ["diff", "file.ts"])).toBe("");
    expect(context.indexTreeBefore).toBeDefined();

    await resetStaged(root, context);

    const stagedAfter = await git(root, ["diff", "--cached", "file.ts"]);
    const workingAfter = await git(root, ["diff", "file.ts"]);
    const fileAfter = await readFile(join(root, "file.ts"), "utf8");

    expect(stagedAfter).toBe(stagedBefore);
    expect(workingAfter).toBe(workingBefore);
    expect(fileAfter).toBe(fileBefore);
  });
});

describe("commitAll", () => {
  it("stages untracked files and commits", async () => {
    const root = await makeRepoWithCommit();
    await writeFile(join(root, "new.txt"), "content\n");
    const result = await commitAll(root, "add new file\n\nbody line");
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.subject).toBe("add new file");
    expect(await git(root, ["log", "-1", "--pretty=%B"])).toContain("body line");
    expect((await statusDetails(root)).hasChanges).toBe(false);
  });

  it("rejects empty messages and clean trees", async () => {
    const root = await makeRepoWithCommit();
    await expect(commitAll(root, "   ")).rejects.toThrow(/commit message/);
    await expect(commitAll(root, "nothing to commit")).rejects.toThrow(/no changes/);
  });
});

describe("push and pull", () => {
  async function withBareRemote(): Promise<{ root: string; remote: string }> {
    const root = await makeRepoWithCommit();
    const remote = join(root, "..", "remote.git");
    await git(root, ["init", "--bare", remote]);
    await git(root, ["remote", "add", "origin", remote]);
    return { root, remote };
  }

  it("pushes with upstream and then reports up-to-date", async () => {
    const { root } = await withBareRemote();
    const first = await pushCurrentBranch(root);
    expect(first.status).toBe("pushed");
    expect(first.setUpstream).toBe(true);
    const second = await pushCurrentBranch(root);
    expect(second.status).toBe("skipped_up_to_date");
  });

  it("pulls new commits fast-forward", async () => {
    const { root, remote } = await withBareRemote();
    await pushCurrentBranch(root);

    const clone = join(root, "..", "clone");
    await git(root, ["clone", remote, clone]);
    await git(clone, ["config", "user.email", "other@example.com"]);
    await git(clone, ["config", "user.name", "Other"]);
    // The bare remote's HEAD still points at master, so the clone checks out
    // nothing; base main on the fetched origin/main before committing.
    await git(clone, ["checkout", "-B", "main", "origin/main"]);
    await writeFile(join(clone, "from-clone.txt"), "x\n");
    await git(clone, ["add", "from-clone.txt"]);
    await git(clone, ["commit", "-m", "from clone"]);
    await git(clone, ["push", "-u", "origin", "main"]);

    const pulled = await pullCurrentBranch(root);
    expect(pulled.status).toBe("pulled");
    const details = await statusDetails(root);
    expect(details.files.some((f) => f.path === "from-clone.txt")).toBe(false);
    expect(details.behind).toBe(0);
  });

  it("refuses to pull without an upstream", async () => {
    const root = await makeRepoWithCommit();
    await expect(pullCurrentBranch(root)).rejects.toThrow(/no upstream/);
  });
});

describe("branches", () => {
  it("lists, creates, and switches branches", async () => {
    const root = await makeRepoWithCommit();
    const before = await listBranches(root);
    expect(before.branches.map((b) => b.name)).toEqual(["main"]);
    expect(before.current).toBe("main");

    await createBranch(root, "feature/x", true);
    const after = await listBranches(root);
    expect(after.current).toBe("feature/x");
    expect(after.branches.map((b) => b.name).sort()).toEqual(["feature/x", "main"]);

    await switchBranch(root, "main");
    expect((await listBranches(root)).current).toBe("main");
  });

  it("rejects duplicate branch names and dirty switches", async () => {
    const root = await makeRepoWithCommit();
    await expect(createBranch(root, "main", false)).rejects.toThrow(/already exists/);
    await writeFile(join(root, "dirty.txt"), "x\n");
    await expect(switchBranch(root, "main")).rejects.toThrow(/commit or stash/);
  });

  it("validates branch names", () => {
    expect(validateBranchName("feature/ok-1.2")).toBe("feature/ok-1.2");
    expect(() => validateBranchName("")).toThrow();
    expect(() => validateBranchName("-lead")).toThrow();
    expect(() => validateBranchName("a//b")).toThrow();
    expect(() => validateBranchName("trail/")).toThrow();
    expect(() => validateBranchName("has space")).toThrow();
  });
});

describe("provider detection", () => {
  it("detects github and gitlab remotes", () => {
    expect(detectProviderFromRemoteUrl("git@github.com:owner/repo.git")).toBe("github");
    expect(detectProviderFromRemoteUrl("https://github.com/owner/repo")).toBe("github");
    expect(detectProviderFromRemoteUrl("https://gitlab.com/group/project.git")).toBe("gitlab");
    expect(detectProviderFromRemoteUrl("ssh://git@gitlab.example.com/g/p.git")).toBe("gitlab");
    expect(detectProviderFromRemoteUrl("https://example.com/owner/repo.git")).toBe("unknown");
    expect(detectProviderFromRemoteUrl("")).toBe("unknown");
  });
});

describe("suggestPrContent", () => {
  it("derives the title from a single commit", async () => {
    const root = await makeRepoWithCommit();
    await git(root, ["checkout", "-b", "feature"]);
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    await git(root, ["add", "file.txt"]);
    await git(root, ["commit", "-m", "add the feature"]);
    const suggested = await suggestPrContent(root);
    expect(suggested.title).toBe("add the feature");
    expect(suggested.baseBranch).toBe("main");
    expect(suggested.headBranch).toBe("feature");
    expect(suggested.body).toContain("add the feature");
  });
});
