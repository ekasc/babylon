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

/** The retained AgentSession behind a known session file (tests drive the
 *  session manager directly; production goes through addressed APIs). */
function sessionOf(host: PiHost, file: string) {
  const entry = host.testSessions().get(file);
  if (!entry) throw new Error(`no retained session for ${file}`);
  return entry.runtime.session;
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

    const host = new PiHost({ cwd, agentDir, stateDir, onEvent: () => undefined });
    await host.start();
    // The test drives one exact transcript: create it, then let it own the
    // project. Ownership identity comes back from the activation itself.
    const isolated = (await import("@earendil-works/pi-coding-agent")).SessionManager.create(cwd, sessionDir);
    const owner = await host.activateExecution(cwd, isolated.getSessionFile()!);
    const sessionFile = owner.sessionFile;

    const start = await host.testCaptureTurnStart(sessionFile);
    expect(start).not.toBeNull();
    if (!start || "skipped" in start) throw new Error("expected a turn checkpoint");
    const parentLeafId = sessionOf(host, sessionFile).sessionManager.getLeafId();
    const userEntryId = sessionOf(host, sessionFile).sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "make the bad change" }],
      timestamp: Date.now(),
    });
    const assistantEntryId = sessionOf(host, sessionFile).sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "changed" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    await writeFile(join(cwd, "file.txt"), "after\n");
    await host.testCaptureTurnEnd(start, sessionFile);

    const history = await host.getHistory(sessionFile);
    expect(history.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryId: userEntryId, rollbackAvailable: true }),
    ]));

    const plan = await host.prepareRollback(sessionFile, userEntryId);
    expect(plan).toMatchObject({ abandonedCount: 1, counts: { modified: 1 } });
    const rolled = await host.commitRollback(plan.planId);
    expect(rolled.editorText).toBe("make the bad change");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("before\n");
    expect(sessionOf(host, sessionFile).sessionManager.getLeafId()).toBe(parentLeafId);
    expect((await host.getHistory(sessionFile)).activeRollback).toMatchObject({ undoAvailable: true });
    await host.dispose();

    const reopened = new PiHost({ cwd, agentDir, stateDir, onEvent: () => undefined });
    await reopened.start();
    await reopened.activateExecution(cwd, sessionFile);
    expect(sessionOf(reopened, sessionFile).sessionManager.getLeafId()).toBe(parentLeafId);
    expect((await reopened.getHistory(sessionFile)).activeRollback).toMatchObject({ undoAvailable: true });

    await reopened.undoRollback(sessionFile);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("after\n");
    expect(sessionOf(reopened, sessionFile).sessionManager.getLeafId()).toBe(assistantEntryId);
    expect((await reopened.getHistory(sessionFile)).activeRollback).toBeUndefined();
    await reopened.dispose();
  }, 30_000);

  it("excludes agent bookkeeping from turn checkpoints and rollback plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-rollback-bookkeeping-"));
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

    const host = new PiHost({ cwd, agentDir, stateDir, onEvent: () => undefined });
    await host.start();
    // The test drives one exact transcript: create it, then let it own the
    // project. Ownership identity comes back from the activation itself.
    const isolated = (await import("@earendil-works/pi-coding-agent")).SessionManager.create(cwd, sessionDir);
    const owner = await host.activateExecution(cwd, isolated.getSessionFile()!);
    const sessionFile = owner.sessionFile;
    const appendTurn = (text: string) => {
      const userEntryId = sessionOf(host, sessionFile).sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      });
      sessionOf(host, sessionFile).sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      return userEntryId;
    };

    // Turn 1: a real edit plus the guardrail log append every tool call
    // produces. Only the real edit may be recorded or rolled back.
    const start = await host.testCaptureTurnStart(sessionFile);
    if (!start || "skipped" in start) throw new Error("expected a turn checkpoint");
    const u1 = appendTurn("change the file");
    await writeFile(join(cwd, "file.txt"), "after\n");
    await mkdir(join(cwd, ".pi", "state", "guardrails"), { recursive: true });
    await writeFile(join(cwd, ".pi", "state", "guardrails", "decisions.jsonl"), '{"at":1}\n');
    await host.testCaptureTurnEnd(start, sessionFile);
    expect((await host.getHistory(sessionFile)).turns.find((t) => t.entryId === u1)?.changedCount).toBe(1);
    const sessionFile2 = sessionFile;
    const plan = await host.prepareRollback(sessionFile2, u1);
    expect(plan.changes.map((c) => c.path)).toEqual(["file.txt"]);

    // Turn 2: bookkeeping writes only (the read-only turn). No card.
    const start2 = await host.testCaptureTurnStart(sessionFile);
    if (!start2 || "skipped" in start2) throw new Error("expected a turn checkpoint");
    const u2 = appendTurn("read things");
    await writeFile(join(cwd, ".pi", "state", "guardrails", "decisions.jsonl"), '{"at":1}\n{"at":2}\n');
    await host.testCaptureTurnEnd(start2, sessionFile);
    expect((await host.getHistory(sessionFile)).turns.find((t) => t.entryId === u2)?.changedCount).toBe(0);
    await host.dispose();
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

    const host = new PiHost({ cwd, agentDir, stateDir, onEvent: () => undefined });
    await host.start();
    // The test drives one exact transcript: create it, then let it own the
    // project. Ownership identity comes back from the activation itself.
    const isolated = (await import("@earendil-works/pi-coding-agent")).SessionManager.create(cwd, sessionDir);
    const owner = await host.activateExecution(cwd, isolated.getSessionFile()!);
    const sessionFile = owner.sessionFile;

    const start = await host.testCaptureTurnStart(sessionFile);
    expect(start).not.toBeNull();
    if (!start || "skipped" in start) throw new Error("expected a turn checkpoint");
    const userEntryId = sessionOf(host, sessionFile).sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "make the bad change" }],
      timestamp: Date.now(),
    });
    const assistantEntryId = sessionOf(host, sessionFile).sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "changed" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    await writeFile(join(cwd, "file.txt"), "after\n");
    await host.testCaptureTurnEnd(start, sessionFile);

    // Simulate: the agent finished and the file is "after" (call it B). The
    // user now immediately edits to C with no settle() / no wait, and clicks
    // Rollback. The drift guard inside commitRollback must see the changed
    // worktree and refuse; the file must remain at C.
    const sessionFile3 = sessionFile;
    const plan = await host.prepareRollback(sessionFile3, userEntryId);
    expect(plan).toMatchObject({ abandonedCount: 1 });
    await writeFile(join(cwd, "file.txt"), "manual-C\n");
    await expect(host.commitRollback(plan.planId)).rejects.toThrow(/changed/i);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("manual-C\n");
    // The aborted plan must not have left the active rollback registered.
    expect((await host.getHistory(sessionFile)).activeRollback).toBeUndefined();
    expect(sessionOf(host, sessionFile).sessionManager.getLeafId()).not.toBe(userEntryId);
    void assistantEntryId;
    await host.dispose();
  }, 30_000);

  it("marks the turn incomplete when the agent deletes an oversized untracked file (rollback completeness)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-rollback-excl-deleted-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const stateDir = join(root, "state");
    const sessionDir = join(root, "sessions");
    await mkdir(cwd);
    await mkdir(agentDir);
    await git(cwd, ["init"]);
    await writeFile(join(cwd, "f.txt"), "f\n");
    await git(cwd, ["add", "f.txt"]);

    // Create a 3MB untracked file BEFORE the pre-turn checkpoint so
    // the snapshot records it as excluded (cannot be restored).
    const huge = join(cwd, "huge.log");
    await writeFile(huge, Buffer.alloc(3 * 1024 * 1024, "x"));

    const host = new PiHost({ cwd, agentDir, stateDir, onEvent: () => undefined });
    await host.start();
    // The test drives one exact transcript: create it, then let it own the
    // project. Ownership identity comes back from the activation itself.
    const isolated = (await import("@earendil-works/pi-coding-agent")).SessionManager.create(cwd, sessionDir);
    const owner = await host.activateExecution(cwd, isolated.getSessionFile()!);
    const sessionFile = owner.sessionFile;

    const start = await host.testCaptureTurnStart(sessionFile);
    expect(start).not.toBeNull();
    if (!start || "skipped" in start) throw new Error("expected a turn checkpoint");
    expect(start.before.excluded.map((e) => e.path)).toContain("huge.log");

    const userEntryId = sessionOf(host, sessionFile).sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "delete the log" }],
      timestamp: Date.now(),
    });
    sessionOf(host, sessionFile).sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    // "Agent" deletes the oversized untracked file. Babylon cannot
    // restore it, so the post-turn capture must reflect that.
    await rm(huge);
    await host.testCaptureTurnEnd(start, sessionFile);

    const history = await host.getHistory(sessionFile);
    const turn = history.turns.find((t) => t.entryId === userEntryId);
    expect(turn).toBeDefined();
    // The deletion of an excluded path must surface as an exclusion
    // change, so the turn is NOT advertised as fully restorable.
    // rollbackAvailable and checkpointAvailable are the user-facing
    // signals: both must be false.
    expect(turn?.rollbackAvailable).toBe(false);
    expect(turn?.checkpointAvailable).toBe(false);
    await host.dispose();
  }, 30_000);

  it("refuses to commit a plan for a session that no longer owns execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-rollback-ownership-"));
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

    const host = new PiHost({ cwd, agentDir, stateDir, onEvent: () => undefined });
    await host.start();
    // The test drives one exact transcript: create it, then let it own the
    // project. Ownership identity comes back from the activation itself.
    const isolated = (await import("@earendil-works/pi-coding-agent")).SessionManager.create(cwd, sessionDir);
    const owner = await host.activateExecution(cwd, isolated.getSessionFile()!);
    const sessionFile = owner.sessionFile;

    // Real turn → checkpoint → rollback plan against the OWNER session.
    const start = await host.testCaptureTurnStart(sessionFile);
    if (!start || "skipped" in start) throw new Error("expected a turn checkpoint");
    const userEntryId = sessionOf(host, sessionFile).sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "make the change" }],
      timestamp: Date.now(),
    });
    await writeFile(join(cwd, "file.txt"), "after\n");
    await host.testCaptureTurnEnd(start, sessionFile);
    const plan = await host.prepareRollback(sessionFile, userEntryId);

    // Ownership moves: release A, another session owns the project.
    expect(await host.deactivateExecution(cwd, sessionFile)).toBe(true);
    const otherFile = (await import("@earendil-works/pi-coding-agent")).SessionManager.create(cwd, sessionDir).getSessionFile()!;
    await host.activateExecution(cwd, otherFile);
    // A is now DISK-ONLY (one runtime per project): the stale Confirm
    // addresses a session with neither a runtime nor execution rights, and
    // must fail before touching project files.
    expect(host.testSessions().has(sessionFile)).toBe(false);
    await writeFile(join(cwd, "file.txt"), "manual-edit\n");

    await expect(host.commitRollback(plan.planId)).rejects.toThrow(/runtime is not available/);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("manual-edit\n");
    await host.dispose();
  }, 30_000);
});
