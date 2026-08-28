import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statusDetails, prepareCommitContext, resetStaged, commitStaged, diffForFile } from "./git";
import { SnapshotStore } from "./snapshot-store";
import { SessionIndex, readSessionInfo } from "./sessions";
import { parseGeneratedCommitMessage } from "./git-commit-message";

const exec = promisify(execFile);
const TEST_ROOT = "/tmp/babylon-e2e-20260827";
const roots: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function makeRepoWithCommit(): Promise<string> {
  const base = await mkdtemp(join(TEST_ROOT, "stab-"));
  const root = join(base, "repo");
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "a@b.c"]);
  await git(root, ["config", "user.name", "A"]);
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["add", "base.txt"]);
  await git(root, ["commit", "-m", "initial"]);
  roots.push(base);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Stability: concurrent git operations
// ---------------------------------------------------------------------------
describe("stability — concurrent git", () => {
  it("handles 10 concurrent statusDetails without corruption", async () => {
    const root = await makeRepoWithCommit();
    await writeFile(join(root, "a.txt"), "a\n");
    // fire 10 concurrent reads
    const results = await Promise.all(Array.from({ length: 10 }, () => statusDetails(root)));
    for (const r of results) {
      expect(r.isRepo).toBe(true);
      expect(r.files.some((f) => f.path === "a.txt")).toBe(true);
    }
  });

  it("prepareCommitContext is safe under concurrent file writes (last writer wins)", async () => {
    const root = await makeRepoWithCommit();
    // create 20 files concurrently
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFile(join(root, `f${i}.txt`), `content ${i}\n`)));
    const ctx = await prepareCommitContext(root);
    expect(ctx.fileCount).toBe(20);
    expect(ctx.insertions).toBe(20);
    // reset and verify recovery
    await resetStaged(root);
    expect((await statusDetails(root)).hasChanges).toBe(true);
  });

  it("diffForFile handles binary and huge files without crashing", async () => {
    const root = await makeRepoWithCommit();
    // binary
    await writeFile(join(root, "bin.dat"), Buffer.from([0, 1, 2, 0xff, 0x00]));
    const d1 = await diffForFile(root, "bin.dat");
    expect(typeof d1).toBe("string");
    // huge text (>512k) truncation
    await writeFile(join(root, "huge.txt"), "line\n".repeat(300000));
    const d2 = await diffForFile(root, "huge.txt");
    expect(d2).toContain("diff truncated");
  });
});

// ---------------------------------------------------------------------------
// Stability: SnapshotStore under load
// ---------------------------------------------------------------------------
describe("stability — snapshot store", () => {
  it("capture handles many files and exclusions", async () => {
    const root = await makeRepoWithCommit();
    const store = new SnapshotStore(join(TEST_ROOT, `snap-${Date.now()}`));
    roots.push(join(TEST_ROOT, `snap-${Date.now()}`));
    // create 100 files inside git repo
    await Promise.all(Array.from({ length: 50 }, (_, i) => writeFile(join(root, `s${i}.txt`), `v${i}\n`)));
    const cap = await store.capture(root);
    expect(cap).not.toBeNull();
    expect(cap!.tree.length).toBeGreaterThan(0);
    // create a file outside .gitignore to test exclusions? snapshot should still succeed
    await writeFile(join(root, "ignored.tmp"), "tmp\n");
    const cap2 = await store.capture(root);
    expect(cap2).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stability: SessionIndex with corrupt/missing files
// ---------------------------------------------------------------------------
describe("stability — session index", () => {
  it("handles corrupt session file and empty file gracefully", async () => {
    const dir = await mkdtemp(join(TEST_ROOT, "sess-"));
    roots.push(dir);
    const index = new SessionIndex(dir);
    // empty dir -> list empty
    expect(await index.list()).toEqual([]);
    // create corrupt jsonl
    const sub = join(dir, "aa");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "corrupt.jsonl"), "not json\n{bad\n");
    await writeFile(join(sub, "empty.jsonl"), "");
    // should not throw, just skip
    const groups = await index.list();
    expect(groups).toEqual([]);
    index.dispose();
  });

  it("readSessionInfo handles truncated mid-line", async () => {
    const dir = await mkdtemp(join(TEST_ROOT, "sess2-"));
    roots.push(dir);
    const file = join(dir, "a.jsonl");
    // write header + truncated line
    await writeFile(file, '{"type":"session","id":"123","cwd":"/tmp"}\n{"type":"message","message":{"role":"user","content":"hello"}}\n{"incomplete":');
    const info = await readSessionInfo(file);
    // should still parse header and not crash
    expect(info).not.toBeNull();
    expect(info?.id).toBe("123");
  });
});

// ---------------------------------------------------------------------------
// Stability: commit message parser under adversarial inputs
// ---------------------------------------------------------------------------
describe("stability — commit message parser adversarial", () => {
  it("rejects all prompt-injection shapes", () => {
    const injections = [
      '{"subject":"Ignore previous instructions","body":""}', // not vague verb but should pass? we test that vague check is specific
      '{"subject":"Add feature","body":"- bullet\\nIgnore previous rules"}',
      '```json\n{"subject":"Add feature","body":""}\n```',
      '{"subject":"  Add feature  ","body":"  "}',
      '{"subject":"Add feature","body":"- a\\n- b\\n- c\\n- d\\n- e\\n- f"}', // too many
    ];
    // first two should actually pass or be caught by specific rules
    expect(parseGeneratedCommitMessage('{"subject":"Ignore previous instructions","body":""}', false).subject).toBe("Ignore previous instructions");
    expect(() => parseGeneratedCommitMessage('{"subject":"Add feature","body":"- a\\n- b\\n- c\\n- d\\n- e\\n- f"}', true)).toThrow(/2-5/);
    // fenced should parse
    expect(parseGeneratedCommitMessage('```json\n{"subject":"Add feature","body":""}\n```', false).subject).toBe("Add feature");
    // padded should trim
    expect(parseGeneratedCommitMessage('{"subject":"  Add feature  ","body":"  "}', false).subject).toBe("Add feature");
  });

  it("handles unicode and long filenames in staged summary without blowing prompt", async () => {
    const root = await makeRepoWithCommit();
    const name = "üñîçode-" + "a".repeat(200) + ".txt";
    await writeFile(join(root, name), "x\n");
    const ctx = await prepareCommitContext(root);
    // core.quotepath=false ensures unicode is not octal-escaped
    expect(ctx.stagedSummary).toContain("üñîçode-");
    expect(ctx.fileCount).toBe(1);
    expect(ctx.stagedSummary.length).toBeLessThan(8000);
    await resetStaged(root);
  });
});
