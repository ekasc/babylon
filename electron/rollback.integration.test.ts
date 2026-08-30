import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PiHost } from "./pi-host";

const exec = promisify(execFile);
const roots: string[] = [];

// Both turn-start and turn-end snapshots are authoritative (they read Git/FS
// directly), so the worktree edits are observed immediately without waiting on
// the eventually-consistent kernel watcher.
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function git(cwd: string, args: string[]): Promise<void> {
  await exec("git", args, { cwd });
}

describe("PiHost rollback integration", () => {
  it("rolls conversation and files back together and can undo the rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-rollback-host-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const stateDir = join(root, "state");
    const sessionDir = join(root, "sessions");
    await mkdir(cwd);
    await mkdir(agentDir);
    await git(cwd, ["init"]);
    await writeFile(join(cwd, "file.txt"), "before\n");
    await git(cwd, ["add", "file.txt"]);

    const host = new PiHost({ cwd, agentDir, stateDir, onEvent: () => undefined, onStatus: () => undefined });
    await host.start();
    await host.open({ cwd });
    const isolated = (await import("@earendil-works/pi-coding-agent")).SessionManager.create(cwd, sessionDir);
    await host.switchTo(isolated.getSessionFile()!, { cwdOverride: cwd });

    const start = await (host as any).captureTurnStart();
    expect(start).not.toBeNull();
    const parentLeafId = host.session.sessionManager.getLeafId();
    const userEntryId = host.session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "make the bad change" }],
      timestamp: Date.now(),
    } as any);
    const assistantEntryId = host.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "changed" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    } as any);
    await writeFile(join(cwd, "file.txt"), "after\n");
    await (host as any).captureTurnEnd(start);

    const history = await host.getHistory();
    expect(history.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryId: userEntryId, rollbackAvailable: true }),
    ]));

    const plan = await host.prepareRollback(userEntryId);
    expect(plan).toMatchObject({ abandonedCount: 1, counts: { modified: 1 } });
    const rolled = await host.commitRollback(plan.planId);
    expect(rolled.editorText).toBe("make the bad change");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("before\n");
    expect(host.session.sessionManager.getLeafId()).toBe(parentLeafId);
    expect((await host.getHistory()).activeRollback).toMatchObject({ undoAvailable: true });
    const sessionFile = (await host.getState()).sessionFile as string;
    await host.dispose();

    const reopened = new PiHost({ cwd, agentDir, stateDir, onEvent: () => undefined, onStatus: () => undefined });
    await reopened.start();
    await reopened.open({ cwd, path: sessionFile });
    expect(reopened.session.sessionManager.getLeafId()).toBe(parentLeafId);
    expect((await reopened.getHistory()).activeRollback).toMatchObject({ undoAvailable: true });

    await reopened.undoRollback();
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("after\n");
    expect(reopened.session.sessionManager.getLeafId()).toBe(assistantEntryId);
    expect((await reopened.getHistory()).activeRollback).toBeUndefined();
    await reopened.dispose();
  }, 30_000);

  it("refuses rollback when the user edited the worktree between plan and commit (destructive boundary)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-rollback-stale-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const stateDir = join(root, "state");
    const sessionDir = join(root, "sessions");
    await mkdir(cwd);
    await mkdir(agentDir);
    await git(cwd, ["init"]);
    await writeFile(join(cwd, "file.txt"), "before\n");
    await git(cwd, ["add", "file.txt"]);

    const host = new PiHost({ cwd, agentDir, stateDir, onEvent: () => undefined, onStatus: () => undefined });
    await host.start();
    await host.open({ cwd });
    const isolated = (await import("@earendil-works/pi-coding-agent")).SessionManager.create(cwd, sessionDir);
    await host.switchTo(isolated.getSessionFile()!, { cwdOverride: cwd });

    const start = await (host as any).captureTurnStart();
    expect(start).not.toBeNull();
    const userEntryId = host.session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "make the bad change" }],
      timestamp: Date.now(),
    } as any);
    const assistantEntryId = host.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "changed" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    } as any);
    await writeFile(join(cwd, "file.txt"), "after\n");
    await (host as any).captureTurnEnd(start);

    // Simulate: the agent finished and the file is "after" (call it B). The
    // user now immediately edits to C with no settle() / no wait, and clicks
    // Rollback. The drift guard inside commitRollback must see the changed
    // worktree and refuse; the file must remain at C.
    const plan = await host.prepareRollback(userEntryId);
    expect(plan).toMatchObject({ abandonedCount: 1 });
    await writeFile(join(cwd, "file.txt"), "manual-C\n");
    await expect(host.commitRollback(plan.planId)).rejects.toThrow(/changed/i);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("manual-C\n");
    // The aborted plan must not have left the active rollback registered.
    expect((await host.getHistory()).activeRollback).toBeUndefined();
    expect(host.session.sessionManager.getLeafId()).not.toBe(userEntryId);
    void assistantEntryId;
    await host.dispose();
  }, 30_000);
});
