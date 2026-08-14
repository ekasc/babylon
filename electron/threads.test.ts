import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectThreadEvents, ThreadManager } from "./threads";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function threadState(cwd: string, threadId: string, sessionFile: string, status = "stopped") {
  return {
    cwd,
    threadId,
    name: "audit thread",
    goal: "Audit the codebase",
    status,
    mode: "background",
    profile: "full",
    contextMode: "fresh",
    model: "provider/model",
    thinking: "high",
    parentSessionId: "019ff998-c4bf-77af-813d-649121d268eb",
    sessionDir: join(cwd, ".pi", "threads", threadId, "sessions"),
    sessionFile,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    latestActivity: "Idle",
    recentMessages: [],
    revision: 1,
  };
}

async function writeThread(state: Record<string, unknown>): Promise<void> {
  const dir = join(state.cwd as string, ".pi", "state", "threads", state.threadId as string);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "thread.json"), JSON.stringify(state));
}

describe("ThreadManager controls", () => {
  it("executes the extension tool and notifies the parent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "babylon-thread-steer-"));
    roots.push(cwd);
    const threadId = "12345678-1234-1234-1234-123456789abc";
    const sessionFile = join(cwd, "thread.jsonl");
    await writeFile(sessionFile, "session\n");
    await writeThread(threadState(cwd, threadId, sessionFile, "idle"));
    const runTool = vi.fn(async () => ({ content: [{ type: "text", text: "steered" }] }));
    const onParentMessage = vi.fn(async () => undefined);
    const manager = new ThreadManager({ runTool, onParentMessage });

    const result = await manager.control(cwd, "steer", threadId, "change direction");
    expect(runTool).toHaveBeenCalledWith("send_input", {
      threadId,
      message: "change direction",
      delivery: "steer",
    });
    expect(onParentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId }),
      "steer",
      "change direction"
    );
    expect(result.threadId).toBe(threadId);
  });

  it("maps stop to close_thread and surfaces tool errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "babylon-thread-stop-"));
    roots.push(cwd);
    const threadId = "12345678-1234-1234-1234-123456789abc";
    await writeThread(threadState(cwd, threadId, join(cwd, "t.jsonl"), "running"));
    const runTool = vi.fn(async () => ({ isError: true, content: [{ type: "text", text: "thread gone" }] }));
    const manager = new ThreadManager({ runTool });
    await expect(manager.control(cwd, "stop", threadId)).rejects.toThrow("thread gone");
    expect(runTool).toHaveBeenCalledWith("close_thread", expect.objectContaining({ threadId }));
  });
});

describe("ThreadManager promotion", () => {
  it("refuses to promote a live thread", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "babylon-thread-live-"));
    roots.push(cwd);
    const threadId = "12345678-1234-1234-1234-123456789abc";
    await writeFile(join(cwd, "t.jsonl"), JSON.stringify({ type: "session", version: 3, id: "t1", timestamp: "2026-01-01T00:00:00.000Z", cwd }) + "\n");
    await writeThread(threadState(cwd, threadId, join(cwd, "t.jsonl"), "running"));
    const manager = new ThreadManager({ runTool: vi.fn() });
    await expect(manager.promote(cwd, threadId)).rejects.toThrow("Stop or wait for the thread");
  });

  it("promotes a stopped thread and stamps its identity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "babylon-thread-promote-"));
    roots.push(cwd);
    const threadId = "12345678-1234-1234-1234-123456789abc";
    const sessionFile = join(cwd, "thread.jsonl");
    await writeFile(
      sessionFile,
      JSON.stringify({ type: "session", version: 3, id: "t1", timestamp: "2026-01-01T00:00:00.000Z", cwd }) + "\n"
    );
    await writeThread(threadState(cwd, threadId, sessionFile, "stopped"));
    const manager = new ThreadManager({ runTool: vi.fn() });

    const result = await manager.promote(cwd, threadId);
    expect(result.sessionFile).toBe(sessionFile);
    expect(result.cwd).toBe(cwd);
    expect(result.parentSessionFile).toBeNull(); // parent id not in the sessions store
    const content = await readFile(sessionFile, "utf8");
    expect(content).toContain("babylon_thread_identity");
    expect(content).toContain("You are still thread audit thread");
  });
});

describe("detectThreadEvents (milestone watching)", () => {
  const base = { threadId: "t1", name: "worker", status: "running", blocker: null, milestones: [] };

  it("emits a milestone when a new one is reported", () => {
    const events = detectThreadEvents(
      { status: "running", milestones: [{ at: "2026-01-01T00:00:00Z", name: "plan drafted" }] },
      { ...base, milestones: [
        { at: "2026-01-01T00:00:00Z", name: "plan drafted" },
        { at: "2026-01-01T00:05:00Z", name: "compiles", note: "34/34 tests pass" },
      ] }
    );
    expect(events).toEqual([
      { type: "milestone", threadId: "t1", name: "worker", milestone: { at: "2026-01-01T00:05:00Z", name: "compiles", note: "34/34 tests pass" } },
    ]);
  });

  it("emits terminal transitions exactly once", () => {
    const events = detectThreadEvents({ status: "running" }, { ...base, status: "completed" });
    expect(events).toEqual([{ type: "terminal", threadId: "t1", name: "worker", status: "completed" }]);
    expect(detectThreadEvents({ status: "completed" }, { ...base, status: "completed" })).toEqual([]);
  });

  it("emits blocked transitions with the blocker text", () => {
    const events = detectThreadEvents({ status: "running", blocker: null }, { ...base, status: "blocked", blocker: "waiting on API key" });
    expect(events).toEqual([{ type: "blocked", threadId: "t1", name: "worker", blocker: "waiting on API key" }]);
  });

  it("stays silent when nothing changed", () => {
    expect(detectThreadEvents({ status: "running", milestones: [{ at: "x", name: "y" }] }, { ...base, milestones: [{ at: "x", name: "y" }] })).toEqual([]);
  });
});
