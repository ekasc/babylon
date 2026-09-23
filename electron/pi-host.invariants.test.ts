/**
 * Backend enforcement of the execution/view invariants (src/execution.ts).
 *
 * These run against the real PiHost (no mocked ownership): I1 (one owner per
 * project), I3 (view never changes ownership), I4 (transfer only when idle),
 * I5-backend (releaseSession refuses busy owners), I8 (ownership lives in
 * executionByCwd, never inferred), I9 (historical opens don't own).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost, type HostOptions } from "./pi-host";
import { isProjectExecutionBusy, type ProjectExecution } from "../src/execution";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-exec-${tag}-`));
  const agentDir = await mkdtemp(join(tmpdir(), `pideck-exec-agent-${tag}-`));
  roots.push(cwd, agentDir);
  return { cwd, agentDir };
}

async function makeSessionFile(cwd: string) {
  const sm = SessionManager.create(cwd);
  const file = sm.getSessionFile();
  if (!file) throw new Error("no canonical session file");
  return file;
}

function makeHost(cwd: string, agentDir: string) {
  const statuses: Array<Parameters<HostOptions["onStatus"]>[0]> = [];
  const ownershipPushes: ProjectExecution[] = [];
  const host = new PiHost({
    cwd,
    agentDir,
    stateDir: join(agentDir, "pideck-state"),
    onEvent: () => undefined,
    onStatus: (s) => statuses.push(s),
    onExecutionChanged: (execution) => ownershipPushes.push(execution),
  });
  return { host, statuses, ownershipPushes };
}

/** Shadow the streaming getter on a retained session (instance property
 *  wins over the prototype getter) so a synthetic "working" state is exact. */
function setStreaming(host: PiHost, sessionFile: string, streaming: boolean): void {
  const entry = host.testSessions().get(sessionFile);
  if (!entry) throw new Error(`no entry for ${sessionFile}`);
  Object.defineProperty(entry.runtime.session, "isStreaming", { value: streaming, configurable: true });
}

describe("I1: one top-level execution session per project", () => {
  it("rejects activating a second session while the owner is busy, without touching anything", async () => {
    const { cwd, agentDir } = await makeProject("busy-reject");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    try {
      const fileA1 = await makeSessionFile(cwd);
      const fileA2 = await makeSessionFile(cwd);
      const a1 = await host.activateExecution(cwd, fileA1);
      expect(a1.sessionFile).toBe(fileA1);
      setStreaming(host, fileA1, true);

      const err = await host.activateExecution(cwd, fileA2).catch((e: unknown) => e);
      expect(isProjectExecutionBusy(err)).toBe(true);
      expect((err as { busySessionFile?: string }).busySessionFile).toBe(fileA1);
      // A1 still the owner; A2 was never created (and therefore never
      // prompted); the busy owner was not aborted.
      expect(host.executionForCwd(cwd)?.sessionFile).toBe(fileA1);
      expect(host.testSessions().has(fileA2)).toBe(false);
      expect(host.testSessions().get(fileA1)?.runtime.session.isStreaming).toBe(true);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("rejects a fresh activation while the owner is busy (no second runtime)", async () => {
    const { cwd, agentDir } = await makeProject("busy-fresh");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    try {
      const fileA1 = await makeSessionFile(cwd);
      await host.activateExecution(cwd, fileA1);
      const before = host.testSessions().size;
      setStreaming(host, fileA1, true);
      const freshErr = await host.activateExecution(cwd).catch((e: unknown) => e);
      expect(isProjectExecutionBusy(freshErr)).toBe(true);
      expect(host.testSessions().size).toBe(before);
      expect(host.executionForCwd(cwd)?.sessionFile).toBe(fileA1);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("treats an active workflow run as a busy owner (I4: workflows count)", async () => {
    const { cwd, agentDir } = await makeProject("workflow-busy");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    try {
      const fileA1 = await makeSessionFile(cwd);
      const fileA2 = await makeSessionFile(cwd);
      const a1 = await host.activateExecution(cwd, fileA1);
      // No streaming/UI/subagents — the workflow run alone makes it busy.
      await mkdir(join(cwd, ".pi", "workflows", "runs"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "workflows", "runs", "r1.json"),
        JSON.stringify({ runId: "r1", sessionId: a1.sessionId, status: "running" })
      );
      const busyErr = await host.activateExecution(cwd, fileA2).catch((e: unknown) => e);
      expect(isProjectExecutionBusy(busyErr)).toBe(true);
      expect(host.executionForCwd(cwd)?.sessionFile).toBe(fileA1);
      // A completed run is not evidence of work: transfer succeeds then.
      await writeFile(
        join(cwd, ".pi", "workflows", "runs", "r1.json"),
        JSON.stringify({ runId: "r1", sessionId: a1.sessionId, status: "completed" })
      );
      const a2 = await host.activateExecution(cwd, fileA2);
      expect(a2.sessionFile).toBe(fileA2);
      expect(host.executionForCwd(cwd)?.sessionFile).toBe(fileA2);
      expect(host.testSessions().has(fileA1)).toBe(false);
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("I4: idle owner transfers exactly once", () => {
  it("releases the idle owner and makes the target the owner", async () => {
    const { cwd, agentDir } = await makeProject("transfer");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    try {
      const fileA1 = await makeSessionFile(cwd);
      const fileA2 = await makeSessionFile(cwd);
      await host.activateExecution(cwd, fileA1);
      const gen1 = (await host.listProjectExecutions())[0]?.generation ?? 0;
      expect(gen1).toBeGreaterThanOrEqual(1);

      const a2 = await host.activateExecution(cwd, fileA2);
      expect(a2.sessionFile).toBe(fileA2);
      expect(host.executionForCwd(cwd)?.sessionFile).toBe(fileA2);
      // I4-backend: the released runtime is gone (I9: retained entries only
      // exist while owned/retained — the transfer disposes the old one).
      expect(host.testSessions().has(fileA1)).toBe(false);
      const list = await host.listProjectExecutions();
      expect(list).toHaveLength(1);
      expect(list[0]?.sessionFile).toBe(fileA2);
      expect((list[0]?.generation ?? 0)).toBeGreaterThan(gen1);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("activating the owner again is a no-op that does not bump generation", async () => {
    const { cwd, agentDir } = await makeProject("noop");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    try {
      const fileA1 = await makeSessionFile(cwd);
      const first = await host.activateExecution(cwd, fileA1);
      const again = await host.activateExecution(cwd, fileA1);
      expect(again).toBe(first);
      expect((await host.listProjectExecutions())[0]?.generation).toBe(1);
      expect(host.testSessions().size).toBe(1);
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("projects remain independent", () => {
  it("A1 busy in project A does not block B1 in project B", async () => {
    const a = await makeProject("proj-a");
    const b = await makeProject("proj-b");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA1 = await makeSessionFile(a.cwd);
      const fileB1 = await makeSessionFile(b.cwd);
      await host.activateExecution(a.cwd, fileA1);
      setStreaming(host, fileA1, true);
      // Legal: two projects, two independent running executions (spec A3).
      const b1 = await host.activateExecution(b.cwd, fileB1);
      expect(b1.sessionFile).toBe(fileB1);
      const list = await host.listProjectExecutions();
      expect(list.map((e) => e.cwd).sort()).toEqual([a.cwd, b.cwd].sort());
      expect(list.find((e) => e.cwd === a.cwd)?.streaming).toBe(true);
      expect(list.find((e) => e.cwd === b.cwd)?.streaming).toBe(false);
      // Project A's owner is untouched by B's activation.
      expect(host.executionForCwd(a.cwd)?.sessionFile).toBe(fileA1);
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("I3/I8: view never changes ownership", () => {
  it("open() (today's view path) never registers execution ownership", async () => {
    const { cwd, agentDir } = await makeProject("view-no-own");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    try {
      const fileA1 = await makeSessionFile(cwd);
      await host.open({ path: fileA1, cwd });
      expect(host.testSessions().has(fileA1)).toBe(true);
      // I3 + I8: viewing created a runtime but zero ownership.
      expect(host.executionForCwd(cwd)).toBeNull();
      expect(await host.listProjectExecutions()).toEqual([]);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("viewing a historical session while the owner runs leaves ownership unchanged", async () => {
    const { cwd, agentDir } = await makeProject("view-while-running");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    try {
      const fileA1 = await makeSessionFile(cwd);
      const fileA2 = await makeSessionFile(cwd);
      await host.activateExecution(cwd, fileA1);
      setStreaming(host, fileA1, true);
      // Spec A4: view A2 while A1 runs → sessions grow, ownership doesn't.
      await host.open({ path: fileA2, cwd });
      expect(host.testSessions().size).toBe(2);
      expect(host.executionForCwd(cwd)?.sessionFile).toBe(fileA1);
      expect((await host.listProjectExecutions())[0]?.sessionFile).toBe(fileA1);
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("I5 backend: release never controls a busy execution", () => {
  it("releaseSession refuses the busy owner and the slot keeps it", async () => {
    const { cwd, agentDir } = await makeProject("release-busy");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    try {
      const fileA1 = await makeSessionFile(cwd);
      await host.activateExecution(cwd, fileA1);
      setStreaming(host, fileA1, true);
      expect(await host.releaseSession(fileA1)).toBe(false);
      expect(host.executionForCwd(cwd)?.sessionFile).toBe(fileA1);
      setStreaming(host, fileA1, false);
      expect(await host.releaseSession(fileA1)).toBe(true);
      // Released owner's slot is cleaned lazily on the next resolve.
      expect(host.executionForCwd(cwd)).toBeNull();
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("deactivateExecution", () => {
  it("refuses a mismatched expected owner, a busy owner, then releases an idle one", async () => {
    const { cwd, agentDir } = await makeProject("deactivate");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    try {
      const fileA1 = await makeSessionFile(cwd);
      const fileA2 = await makeSessionFile(cwd);
      expect(await host.deactivateExecution(cwd, fileA1)).toBe(false); // nobody owns yet
      await host.activateExecution(cwd, fileA1);
      expect(await host.deactivateExecution(cwd, fileA2)).toBe(false); // wrong expected
      setStreaming(host, fileA1, true);
      expect(await host.deactivateExecution(cwd, fileA1)).toBe(false); // busy
      expect(host.executionForCwd(cwd)?.sessionFile).toBe(fileA1);
      setStreaming(host, fileA1, false);
      expect(await host.deactivateExecution(cwd, fileA1)).toBe(true);
      expect(host.executionForCwd(cwd)).toBeNull();
      expect(host.testSessions().size).toBe(0);
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("execution ownership push (pideck_execution_changed producer)", () => {
  it("emits on activate and transfer with rising generations; view never emits", async () => {
    const { cwd, agentDir } = await makeProject("push");
    const { host, ownershipPushes } = makeHost(cwd, agentDir);
    await host.start();
    try {
      const fileA1 = await makeSessionFile(cwd);
      const fileA2 = await makeSessionFile(cwd);
      // I3: plain view (open) produces no ownership push.
      await host.open({ path: fileA1, cwd });
      expect(ownershipPushes).toHaveLength(0);

      await host.activateExecution(cwd, fileA1);
      await new Promise((r) => setTimeout(r, 20)); // fire-and-forget emit
      expect(ownershipPushes).toHaveLength(1);
      expect(ownershipPushes[0]?.cwd).toBe(cwd);
      expect(ownershipPushes[0]?.sessionFile).toBe(fileA1);
      expect(ownershipPushes[0]?.generation).toBe(1);

      // Idle transfer emits the new owner with a higher generation; the
      // renderer merge rejects anything older than what it stored.
      await host.activateExecution(cwd, fileA2);
      await new Promise((r) => setTimeout(r, 20));
      expect(ownershipPushes).toHaveLength(2);
      expect(ownershipPushes[1]?.sessionFile).toBe(fileA2);
      expect(ownershipPushes[1]?.generation).toBe(2);
    } finally {
      await host.dispose();
    }
  }, 60_000);
});
