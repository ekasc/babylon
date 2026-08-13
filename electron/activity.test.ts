import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityBridge } from "./activity";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("ActivityBridge", () => {
  it("reads durable thread and subagent extension state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pideck-activity-"));
    roots.push(cwd);
    const threadDir = join(cwd, ".pi", "state", "threads", "thread-1");
    const runDir = join(cwd, ".pi", "state", "subagents", "runs", "run-1");
    await mkdir(threadDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(threadDir, "thread.json"), JSON.stringify({
      threadId: "thread-1", name: "review", goal: "Review code", status: "running", mode: "background",
      profile: "review", model: "provider/model", parentSessionId: "parent", sessionFile: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z", completedAt: null,
      latestSummary: null, latestActivity: "reading", filesChanged: [], commandsRun: [], testsRun: [], blocker: null,
      failureReason: null,
    }));
    await writeFile(join(runDir, "provider-models.jsonl"), JSON.stringify({ at: "2026-01-01T00:00:00Z", requestedModel: "provider/model", sessionModel: "provider/model", payloadModel: "model", matched: true }) + "\n");
    await writeFile(join(runDir, "stdout.log"), "SUBAGENT_OK\n");

    const bridge = new ActivityBridge({ cwd, onUpdate: () => undefined });
    const state = await bridge.list();
    bridge.dispose();
    expect(state.threads[0]).toMatchObject({ threadId: "thread-1", status: "running" });
    expect(state.subagents[0]).toMatchObject({ runId: "run-1", status: "completed", requestedModel: "provider/model" });
  });

  it("reads steerable managed subagent records", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pideck-managed-subagent-"));
    roots.push(cwd);
    const runId = "12345678-1234-1234-1234-123456789abc";
    const runDir = join(cwd, ".pi", "state", "subagents", "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), JSON.stringify({
      version: 1,
      runId,
      name: "reviewer",
      task: "Review the change",
      cwd,
      status: "idle",
      requestedModel: "provider/model",
      sessionModel: "provider/model",
      profile: "read-only",
      thinking: "high",
      sessionFile: join(runDir, "sessions", "run.jsonl"),
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
      completedAt: "2026-01-01T00:00:01Z",
      output: "Ready",
      error: null,
      latestActivity: "Ready for more messages",
      recentMessages: [{ at: "2026-01-01T00:00:01Z", role: "assistant", text: "Ready" }],
      revision: 2,
    }));

    const bridge = new ActivityBridge({ cwd, onUpdate: () => undefined });
    const state = await bridge.list();
    bridge.dispose();
    expect(state.subagents[0]).toMatchObject({
      runId,
      status: "idle",
      controllable: true,
      name: "reviewer",
      task: "Review the change",
      recentMessages: [expect.objectContaining({ role: "assistant", text: "Ready" })],
    });
  });
});
