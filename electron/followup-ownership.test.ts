/**
 * Extension ownership seams (Commit 9):
 *  B — goal/design follow-ups are owner-mapped only: when the services→session
 *      mapping is missing the follow-up SKIPS; it must never fall through to
 *      whichever session is foregrounded.
 *  C — thread tool execution is parent-addressed: an unknown/missing parent
 *      session id throws, even when a (different) session is foregrounded.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost } from "./pi-host";

const hooks = vi.hoisted(() => ({
  fired: false,
  unmap: [] as Array<() => void>,
}));

vi.mock("./goal-mode/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./goal-mode/store")>();
  return {
    ...actual,
    saveSessionGoal: async (cwd: string, sessionId: string, state: Parameters<typeof actual.saveSessionGoal>[2]) => {
      // Drop the services→session mapping at the exact seam the production
      // bug needs: after context() resolved the owner, before sendFollowUp.
      if (!hooks.fired) {
        hooks.fired = true;
        for (const run of hooks.unmap) run();
      }
      return actual.saveSessionGoal(cwd, sessionId, state);
    },
  };
});

const roots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  vi.restoreAllMocks();
  hooks.fired = false;
  hooks.unmap = [];
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-owner-${tag}-`));
  const agentDir = await mkdtemp(join(tmpdir(), `pideck-owner-agent-${tag}-`));
  roots.push(cwd, agentDir);
  return { cwd, agentDir };
}

function makeHost(cwd: string, agentDir: string) {
  return new PiHost({ cwd, agentDir, stateDir: join(agentDir, "state"), onEvent: () => undefined, onStatus: () => undefined });
}

describe("goal follow-up owner mapping", () => {
  it("delivers nothing when the owner mapping is missing — never the foreground session", async () => {
    const a = await makeProject("goal-a");
    const b = await makeProject("goal-b");
    // Isolate the global goal-mode feature config (it is read from
    // PI_CODING_AGENT_DIR, not the host's agentDir) so the command runs on
    // defaults regardless of the developer machine's ~/.pi state.
    process.env.PI_CODING_AGENT_DIR = a.agentDir;
    const host = makeHost(a.cwd, a.agentDir);
    await host.start();
    const warnSpy = vi.spyOn(console, "warn");
    try {
      const smA = SessionManager.create(a.cwd);
      const fileA = smA.getSessionFile();
      const smB = SessionManager.create(b.cwd);
      const fileB = smB.getSessionFile();
      if (!fileA || !fileB) throw new Error("no canonical session file");
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      await host.open({ path: fileB, cwd: b.cwd });
      expect(host.activeSessionFile).toBe(fileB);

      const entryA = host.testSessions().get(fileA)!;
      const entryB = host.testSessions().get(fileB)!;
      const sendA = vi.spyOn(entryA.runtime.session, "sendUserMessage").mockImplementation(async () => undefined);
      const sendB = vi.spyOn(entryB.runtime.session, "sendUserMessage").mockImplementation(async () => undefined);

      const ownerHost = host as unknown as { sessionForServices: WeakMap<object, unknown> };
      expect(ownerHost.sessionForServices.get(entryA.services)).toBe(entryA.runtime.session);
      hooks.fired = false;
      hooks.unmap = [() => ownerHost.sessionForServices.delete(entryA.services)];

      await host.prompt("/goal Own the race condition", undefined, undefined, fileA);

      // The seam actually fired: mapping gone, goal saved by the command.
      expect(hooks.fired).toBe(true);
      expect(ownerHost.sessionForServices.get(entryA.services)).toBeUndefined();
      const { loadSessionGoal } = await import("./goal-mode/store");
      const goal = await loadSessionGoal(a.cwd, entryA.sessionId);
      expect(goal?.active).toBe(true);
      // The follow-up closure ran, found no owner, and skipped…
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/goal follow-up missing owning session/));
      // …so NEITHER session received it: not the owner, and emphatically
      // not the foreground session B.
      expect(sendB).not.toHaveBeenCalled();
      expect(sendA).not.toHaveBeenCalled();
      expect(host.activeSessionFile).toBe(fileB);
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("thread tool parent ownership", () => {
  it("throws for a missing or unknown parent session even when another session is foregrounded", async () => {
    const a = await makeProject("thread-a");
    const b = await makeProject("thread-b");
    const host = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const smA = SessionManager.create(a.cwd);
      const fileA = smA.getSessionFile();
      const smB = SessionManager.create(b.cwd);
      const fileB = smB.getSessionFile();
      if (!fileA || !fileB) throw new Error("no canonical session file");
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      await host.open({ path: fileB, cwd: b.cwd });
      expect(host.activeSessionFile).toBe(fileB);
      const entryA = host.testSessions().get(fileA)!;

      const seam = host as unknown as { getSessionTools(sessionId: string | null | undefined): { cwd: string } };
      // Missing identity is a protocol error, never a foreground default.
      expect(() => seam.getSessionTools(undefined)).toThrow(/requires parent session identity/);
      expect(() => seam.getSessionTools(null)).toThrow(/requires parent session identity/);
      // An unknown parent id must not execute tools against foreground B.
      expect(() => seam.getSessionTools("019ff998-0000-4000-8000-000000000000")).toThrow(/parent session runtime is unavailable/);
      // The real parent resolves to ITS project.
      expect(seam.getSessionTools(entryA.sessionId).cwd).toBe(a.cwd);
      expect(host.activeSessionFile).toBe(fileB);
    } finally {
      await host.dispose();
    }
  }, 60_000);
});
