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

describe("ActivityRegistry focus", () => {
  it("clearFocus forgets the destination but keeps the project's live bridge", async () => {
    const p = await makeProject("clear-focus");
    await writeThread(p, "t1", "running", "/p/s.jsonl");
    const registry = makeRegistry();
    registry.ensure(p);
    // Focused, with its bridge tracked.
    expect(registry.tracked()).toContain(p);

    registry.clearFocus();

    // The bridge is NOT disposed: the project stays tracked, so live
    // background work keeps its home...
    expect(registry.tracked()).toContain(p);
    // ...while an unattributed event can no longer be routed into it: with no
    // cwd on the event and no focus, there is nowhere for it to go.
    // An event with no identity at all: neither sessionFile nor cwd.
    await registry.observeAgentEvent({ type: "agent_start" });
    expect(registry.focusedCwdForTest()).toBeNull();
    registry.disposeAll();
  });

  it("focusedCwd is null after clearFocus and restored by ensure", async () => {
    const p = await makeProject("focus-seam");
    const registry = makeRegistry();
    expect(registry.focusedCwdForTest()).toBeNull();
    registry.ensure(p);
    expect(registry.focusedCwdForTest()).toBe(p);
    registry.clearFocus();
    expect(registry.focusedCwdForTest()).toBeNull();
    registry.disposeAll();
  });

  it("focusing again restores the destination", async () => {
    const p = await makeProject("refocus");
    const registry = makeRegistry();
    registry.ensure(p);
    registry.clearFocus();
    registry.ensure(p);
    expect(registry.tracked()).toContain(p);
    registry.disposeAll();
  });
});

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
    if (!last) throw new Error("missing update");
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

  it("prunes idle bridges with no live work but keeps their terminal rows frozen", async () => {
    const a = await makeProject("prune-idle");
    const b = await makeProject("prune-live");
    await writeThread(a, "thread-a1", "completed");
    await writeThread(b, "thread-b1", "running");
    const registry = new ActivityRegistry({ pollIntervalMs: 60_000, idleTtlMs: 60_000, onUpdate: () => undefined });
    registry.ensure(a);
    registry.ensure(b);
    await registry.listAll();
    expect(registry.tracked().sort()).toEqual([a, b].sort());
    // Far-future sweep: b has live work -> survives; a is terminal+idle -> pruned.
    registry.pruneIdle(Date.now() + 10 * 60_000);
    expect(registry.tracked()).toEqual([b]);
    const snap = registry.snapshot();
    expect(snap.threads.map((t) => `${t.threadId}:${t.status}`).sort())
      .toEqual(["thread-a1:completed", "thread-b1:running"]);
    registry.disposeAll();
  });

  it("routes events by owning session, not UI focus, and revives pruned bridges", async () => {
    const a = await makeProject("route-a");
    const b = await makeProject("route-b");
    const sessionFileB = join(b, "session-b.jsonl");
    const registry = new ActivityRegistry({
      pollIntervalMs: 60_000,
      idleTtlMs: 60_000,
      onUpdate: () => undefined,
      resolveEventCwd: (file) => (file === sessionFileB ? b : null),
    });
    registry.ensure(a); // a is foregrounded; b has never been visited.
    await registry.observeAgentEvent({
      type: "tool_execution_start", toolName: "subagent",
      toolCallId: "t1", sessionFile: sessionFileB, args: {},
    });
    // b got its own bridge from ownership; nothing leaked into a's view.
    expect(registry.tracked().sort()).toEqual([a, b].sort());
    expect(registry.snapshot().subagents.map((s) => s.runId)).toEqual(["pending-t1"]);
    // End the call (terminal), then sweep everything idle away.
    await registry.observeAgentEvent({
      type: "tool_execution_end", toolName: "subagent",
      toolCallId: "t1", sessionFile: sessionFileB,
      result: { details: { runId: "run-1", status: "completed" }, content: [] },
    });
    registry.pruneIdle(Date.now() + 10 * 60_000);
    expect(registry.tracked()).toEqual([]);
    expect(registry.snapshot().subagents.map((s) => `${s.runId}:${s.status}`)).toEqual(["run-1:completed"]);
    // A new event for b's session revives b — without foregrounding it.
    await registry.observeAgentEvent({
      type: "tool_execution_start", toolName: "subagent",
      toolCallId: "t2", sessionFile: sessionFileB, args: {},
    });
    expect(registry.tracked()).toEqual([b]);
    registry.disposeAll();
  });

  it("caps frozen history: oldest retired projects drop out past the cap", async () => {
    const registry = new ActivityRegistry({ pollIntervalMs: 60_000, idleTtlMs: 60_000, onUpdate: () => undefined });
    const cwds: string[] = [];
    for (let i = 0; i < 55; i++) {
      const cwd = await makeProject(`cap-${i}`);
      cwds.push(cwd);
      await writeThread(cwd, `thread-${i}`, "completed");
      registry.ensure(cwd);
    }
    await registry.listAll();
    registry.pruneIdle(Date.now() + 10 * 60_000);
    expect(registry.tracked()).toEqual([]);
    expect(registry.retiredCount()).toBe(50);
    // Newest 50 survive; the first 5 pruned projects are gone from the aggregate.
    const ids = registry.snapshot().threads.map((t) => t.threadId).sort();
    expect(ids).toHaveLength(50);
    expect(ids).not.toContain("thread-0");
    expect(ids).toContain("thread-54");
    registry.disposeAll();
  });
});
