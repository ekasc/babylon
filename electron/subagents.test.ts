import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedSubagents, type ManagedSubagentRecord } from "./subagents";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function record(cwd: string, runId: string, sessionFile: string): ManagedSubagentRecord {
  return {
    version: 1,
    runId,
    name: "worker",
    task: "Inspect the change",
    cwd,
    status: "idle",
    requestedModel: "provider/model",
    sessionModel: "provider/model",
    profile: "read-only",
    thinking: "high",
    sessionFile,
    parentSessionId: "parent-session",
    parentSessionFile: join(cwd, "parent.jsonl"),
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    output: "done",
    error: null,
    latestActivity: "Ready for more messages",
    recentMessages: [],
    revision: 1,
  };
}

async function writeRecord(value: ManagedSubagentRecord): Promise<void> {
  const dir = join(value.cwd, ".pi", "state", "subagents", "runs", value.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.json"), `${JSON.stringify(value)}\n`);
}

describe("ManagedSubagents controls", () => {
  it("steers the live owning runtime and persists the message", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "babylon-subagent-steer-"));
    roots.push(cwd);
    const runId = "12345678-1234-1234-1234-123456789abc";
    const sessionFile = join(cwd, "worker.jsonl");
    const value = record(cwd, runId, sessionFile);
    await writeFile(sessionFile, "session\n");
    await writeRecord(value);
    const steer = vi.fn(async () => undefined);
    const onParentMessage = vi.fn(async () => undefined);
    const manager = new ManagedSubagents({ agentDir: cwd, modelRuntime: {} as any, onParentMessage });
    (manager as any).runtimes.set(runId, {
      record: value,
      session: { steer },
      running: Promise.resolve(),
      unsubscribe: null,
      timeout: null,
    });

    const next = await manager.control(cwd, "steer", runId, "change direction");
    expect(steer).toHaveBeenCalledWith("[Parent Steering]\nchange direction");
    expect(next.latestActivity).toBe("Steering message queued");
    expect(next.recentMessages.at(-1)).toMatchObject({ role: "user", text: "change direction" });
    expect(onParentMessage).toHaveBeenCalledWith(next, "steer", "change direction");
    const saved = JSON.parse(await readFile(join(cwd, ".pi", "state", "subagents", "runs", runId, "run.json"), "utf8"));
    expect(saved.latestActivity).toBe("Steering message queued");
  });

  it("releases an idle runtime before promoting its session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "babylon-subagent-promote-"));
    roots.push(cwd);
    const runId = "abcdefab-1234-1234-1234-123456789abc";
    const sessionFile = join(cwd, "worker.jsonl");
    const value = record(cwd, runId, sessionFile);
    await writeFile(sessionFile, "session\n");
    await writeRecord(value);
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const sendCustomMessage = vi.fn(async () => undefined);
    const manager = new ManagedSubagents({ agentDir: cwd, modelRuntime: {} as any });
    (manager as any).runtimes.set(runId, {
      record: value,
      session: { dispose, sendCustomMessage },
      running: null,
      unsubscribe,
      timeout: null,
    });

    await expect(manager.promote(cwd, runId)).resolves.toEqual({ sessionFile, cwd, parentSessionFile: value.parentSessionFile });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect((manager as any).runtimes.has(runId)).toBe(false);
    expect(sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "babylon_subagent_identity" }));
    const saved = JSON.parse(await readFile(join(cwd, ".pi", "state", "subagents", "runs", runId, "run.json"), "utf8"));
    expect(saved).toMatchObject({ status: "stopped", latestActivity: "Opened as main session" });
  });
});
