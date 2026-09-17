import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityRegistry, type ActivityUpdate } from "./activity";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-registry-${tag}-`));
  roots.push(cwd);
  return cwd;
}

async function writeThread(cwd: string, threadId: string, status: string, sessionFile: string | null = null) {
  const dir = join(cwd, ".pi", "state", "threads", threadId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "thread.json"), JSON.stringify({
    threadId, name: `thread-${threadId}`, goal: "work", status, mode: "background",
    profile: "default", model: "provider/model", parentSessionId: "parent", sessionFile,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: new Date().toISOString(), completedAt: null,
    latestSummary: null, latestActivity: null, filesChanged: [], commandsRun: [], testsRun: [],
    blocker: null, failureReason: null,
  }));
}

async function writeSubagentRun(cwd: string, runId: string, status: string) {
  const dir = join(cwd, ".pi", "state", "subagents", "runs", runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.json"), JSON.stringify({
    version: 1, runId, name: `agent-${runId}`, task: "do work", cwd, status,
    requestedModel: "provider/model", sessionModel: "provider/model",
    profile: "write", thinking: "medium", sessionFile: null,
    parentSessionId: "parent", parentSessionFile: null,
    startedAt: "2026-01-01T00:00:00Z", updatedAt: new Date().toISOString(),
    completedAt: null, output: null, error: null, latestActivity: null,
    recentMessages: [], revision: 1,
  }));
}

function makeRegistry(onUpdate: (u: ActivityUpdate) => void = () => undefined) {
  const registry = new ActivityRegistry({ pollIntervalMs: 60_000, onUpdate });
  return registry;
}

describe("ActivityRegistry", () => {
  it("aggregates live entries across projects; navigating never drops them", async () => {
    const a = await makeProject("a");
    const b = await makeProject("b");
    await writeThread(a, "thread-a1", "running");
    await writeSubagentRun(a, "12345678-1234-1234-1234-aaaaaaaaaaaa", "running");
    const registry = makeRegistry();
    registry.ensure(a);
    registry.ensure(b);
    // Project B foregrounded AFTER A had live work: A's entries survive.
    let snap = await registry.listAll();
    expect(snap.threads.map((t) => t.threadId)).toEqual(["thread-a1"]);
    expect(snap.subagents.map((s) => s.runId)).toEqual(["12345678-1234-1234-1234-aaaaaaaaaaaa"]);
    // Project B starts its own work: both projects represented, no duplicates.
    await writeThread(b, "thread-b1", "running");
    snap = await registry.listAll();
    expect(snap.threads.map((t) => t.threadId).sort()).toEqual(["thread-a1", "thread-b1"]);
    // Switching back and re-listing does not duplicate entries.
    registry.ensure(a);
    registry.ensure(b);
    snap = await registry.listAll();
    expect(snap.threads).toHaveLength(2);
    expect(snap.subagents).toHaveLength(1);
    registry.disposeAll();
  });

  it("completion transitions only that entry; the roster keeps history", async () => {
    const a = await makeProject("c");
    await writeThread(a, "thread-a1", "running");
    await writeSubagentRun(a, "12345678-1234-1234-1234-bbbbbbbbbbbb", "running");
    const registry = makeRegistry();
    registry.ensure(a);
    expect((await registry.listAll()).subagents.map((s) => s.status)).toEqual(["running"]);
    await writeSubagentRun(a, "12345678-1234-1234-1234-bbbbbbbbbbbb", "stopped");
    const snap = await registry.listAll();
    // The stopped record stays in the snapshot (history); liveness filtering
    // happens renderer-side, so completion can never hide the live thread.
    expect(snap.subagents.map((s) => s.status)).toEqual(["stopped"]);
    expect(snap.threads.map((t) => `${t.threadId}:${t.status}`)).toEqual(["thread-a1:running"]);
    registry.disposeAll();
  });

  it("pushes the aggregate when any tracked project changes", async () => {
    const a = await makeProject("d");
    const updates: ActivityUpdate[] = [];
    const registry = makeRegistry((u) => updates.push(u));
    registry.ensure(a);
    await writeThread(a, "thread-a1", "running");
    await registry.refreshAll();
    const last = updates[updates.length - 1];
    expect(last.threads.map((t) => t.threadId)).toEqual(["thread-a1"]);
    registry.disposeAll();
  });

  it("tracks each project once and drops everything only on dispose", async () => {
    const a = await makeProject("e");
    const registry = makeRegistry();
    registry.ensure(a);
    registry.ensure(a);
    expect(registry.tracked()).toEqual([a]);
    registry.disposeAll();
    expect(registry.tracked()).toEqual([]);
    expect(registry.snapshot()).toEqual({ threads: [], subagents: [] });
  });
});
