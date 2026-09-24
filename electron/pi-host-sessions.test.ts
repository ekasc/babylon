import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { utimesSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost, defaultStateDir, type HostOptions, type SessionEntry } from "./pi-host";
import { loadSessionGoal, saveSessionGoal } from "./goal-mode/store";
import { createDurableGoalState, defaultDurableGoalModeConfig } from "../src/lib/durable-goal";
import { loadDesignState, saveDesignState, clearDesignState, createDesignState } from "./design-mode/store";
import { RollbackStore } from "./rollback-store";
import type { AgentEvent } from "../src/bridge";
import { SnapshotStore } from "./snapshot-store";

const exec = promisify(execFile);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-host-${tag}-`));
  const agentDir = await mkdtemp(join(tmpdir(), `pideck-agent-${tag}-`));
  roots.push(cwd, agentDir);
  return { cwd, agentDir };
}

async function makeSessionFile(cwd: string) {
  const sm = SessionManager.create(cwd);
  const file = sm.getSessionFile();
  if (!file) throw new Error("no canonical session file");
  return file;
}

function makeHost(cwd: string, agentDir: string, sessionsRoot?: string) {
  const events: AgentEvent[] = [];
  const statuses: Array<Parameters<HostOptions["onStatus"]>[0]> = [];
  const host = new PiHost({
    cwd,
    agentDir,
    stateDir: join(agentDir, "pideck-state"),
    ...(sessionsRoot ? { sessionsRoot } : {}),
    onEvent: (ev) => events.push(ev),
    onStatus: (s) => statuses.push(s),
  });
  return { host, events, statuses };
}

describe("Babylon state location", () => {
  it("derives a host's state from its agent dir so host and daemon agree", () => {
    expect(defaultStateDir("/tmp/agent")).toBe("/tmp/agent/pideck-state");
  });
});

describe("rollback snapshot warming", () => {
  it("captures the shadow index when a session opens, before any prompt", async () => {
    const { cwd, agentDir } = await makeProject("warm");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    const capture = vi.spyOn(SnapshotStore.prototype, "capture");
    try {
      const file = await makeSessionFile(cwd);
      await host.open({ path: file, cwd });
      await vi.waitFor(() => {
        const warmed = capture.mock.calls.some(
          (call) => call[0] === cwd && (call[1] as { authoritative?: boolean } | undefined)?.authoritative === true
        );
        expect(warmed).toBe(true);
      });
    } finally {
      capture.mockRestore();
      await host.dispose();
    }
  }, 60_000);
});

describe("project pre-warming", () => {
  it("builds the shadow index without opening a session", async () => {
    const { cwd, agentDir } = await makeProject("warm-project");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    const capture = vi.spyOn(SnapshotStore.prototype, "capture");
    try {
      expect(host.warmProject(cwd)).toEqual({ warmed: true });
      await vi.waitFor(() => {
        const warmed = capture.mock.calls.some(
          (call) => call[0] === cwd && (call[1] as { authoritative?: boolean } | undefined)?.authoritative === true
        );
        expect(warmed).toBe(true);
      });
    } finally {
      capture.mockRestore();
      await host.dispose();
    }
  }, 60_000);
});

describe("PiHost independent session execution", () => {
  it("beginGoalPrompt persists the goal and runs the message as the turn", async () => {
    const a = await makeProject("goal-silent");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      const entry = host.testSessions().get(fileA)!;
      const delivered: string[] = [];
      const promptSpy = vi.spyOn(entry.runtime.session, "prompt").mockImplementation(async (message: string) => {
        delivered.push(`${entry.sessionFile}:${message}`);
      });
      try {
        const result = await host.beginGoalPrompt(fileA, "Fix the race", "Fix the race");
        expect(result.error).toBeNull();
        expect(result.started).toBe(true);
        expect(result.goal?.active).toBe(true);
        expect(result.goal?.objective).toBe("Fix the race");
        expect(result.goal?.status).toBe("planning");
        // Exactly one turn — the message itself — never a synthetic
        // [Goal Mode Start] follow-up.
        expect(delivered).toEqual([`${fileA}:Fix the race`]);
        expect(host.activeSessionFile).toBe(fileA);
      } finally {
        promptSpy.mockRestore();
      }
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("beginGoalPrompt rolls back a goal whose turn never started", async () => {
    const a = await makeProject("goal-rollback");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      const entry = host.testSessions().get(fileA)!;
      const promptSpy = vi.spyOn(entry.runtime.session, "prompt").mockRejectedValue(new Error("pre-start boom"));
      try {
        const result = await host.beginGoalPrompt(fileA, "Fix X", "Fix X");
        expect(result.started).toBe(false);
        expect(result.error).toMatch("pre-start boom");
        expect(result.goal).toBeNull();
        // Nothing persisted: no phantom ACTIVE goal for the next message.
        expect(await loadSessionGoal(a.cwd, entry.sessionId)).toBeNull();
      } finally {
        promptSpy.mockRestore();
      }
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("beginGoalPrompt keeps the goal when the turn started then failed", async () => {
    const a = await makeProject("goal-started");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      const entry = host.testSessions().get(fileA)!;
      // The turn started (user message landed) and then died mid-flight —
      // abort, mid-turn model error. Goal context was already injected.
      const promptSpy = vi.spyOn(entry.runtime.session, "prompt").mockImplementation(async () => {
        entry.runtime.session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Fix X" }], timestamp: Date.now() });
        throw new Error("mid-turn boom");
      });
      try {
        const result = await host.beginGoalPrompt(fileA, "Fix X", "Fix X");
        expect(result.started).toBe(true);
        expect(result.error).toMatch("mid-turn boom");
        expect(result.goal?.active).toBe(true);
        expect(result.goal?.objective).toBe("Fix X");
        const kept = await loadSessionGoal(a.cwd, entry.sessionId);
        expect(kept?.active).toBe(true);
        expect(kept?.objective).toBe("Fix X");
      } finally {
        promptSpy.mockRestore();
      }
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("beginGoalPrompt restores the previous goal on pre-start failure", async () => {
    const a = await makeProject("goal-restore");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      const entry = host.testSessions().get(fileA)!;
      await saveSessionGoal(a.cwd, entry.sessionId, createDurableGoalState("Old goal", defaultDurableGoalModeConfig()));
      const promptSpy = vi.spyOn(entry.runtime.session, "prompt").mockRejectedValue(new Error("pre-start boom"));
      try {
        const result = await host.beginGoalPrompt(fileA, "New goal", "New goal");
        expect(result.started).toBe(false);
        expect(result.error).toMatch("pre-start boom");
        expect(result.goal?.objective).toBe("Old goal");
        expect((await loadSessionGoal(a.cwd, entry.sessionId))?.objective).toBe("Old goal");
      } finally {
        promptSpy.mockRestore();
      }
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("beginGoalPrompt validates objective and session identity", async () => {
    const a = await makeProject("goal-invalid");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await expect(host.beginGoalPrompt(fileA, "   ", "   ")).rejects.toThrow("invalid goal objective");
      await expect(host.beginGoalPrompt(fileA, "x".repeat(4001), "x")).rejects.toThrow("invalid goal objective");
      await expect(host.beginGoalPrompt(join(a.cwd, "nope.jsonl"), "Fix X", "Fix X")).rejects.toThrow();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("execGoalCommand executes on the addressed session, not the foreground", async () => {
    const a = await makeProject("goal-route-a");
    const b = await makeProject("goal-route-b");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      await host.open({ path: fileB, cwd: b.cwd });
      expect(host.activeSessionFile).toBe(fileB);
      const delivered: string[] = [];
      for (const entry of host.testSessions().values()) {
        vi.spyOn(entry.runtime.session, "prompt").mockImplementation(async (message: string) => {
          delivered.push(`${entry.sessionFile}:${message}`);
        });
      }
      await host.execGoalCommand(fileA, "cancel");
      // The cancel ran on A while B stayed foreground — no global
      // foreground coupling in GUI goal controls.
      expect(delivered).toEqual([`${fileA}:/goal cancel`]);
      expect(host.activeSessionFile).toBe(fileB);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("beginDesignPrompt persists the subject and runs the message as the turn", async () => {
    const a = await makeProject("design-silent");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      const entry = host.testSessions().get(fileA)!;
      const delivered: string[] = [];
      const promptSpy = vi.spyOn(entry.runtime.session, "prompt").mockImplementation(async (message: string) => {
        delivered.push(`${entry.sessionFile}:${message}`);
      });
      try {
        const result = await host.beginDesignPrompt(fileA, "Redesign settings", "Redesign settings");
        expect(result.error).toBeNull();
        expect(result.started).toBe(true);
        expect(result.design?.subject).toBe("Redesign settings");
        expect(result.stage).toBe("elicit");
        // Exactly one turn — the message itself, never a synthetic kickoff.
        expect(delivered).toEqual([`${fileA}:Redesign settings`]);
        expect(host.activeSessionFile).toBe(fileA);
      } finally {
        promptSpy.mockRestore();
      }
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("beginDesignPrompt rolls back a subject whose turn never started", async () => {
    const a = await makeProject("design-rollback");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      const entry = host.testSessions().get(fileA)!;
      const promptSpy = vi.spyOn(entry.runtime.session, "prompt").mockRejectedValue(new Error("pre-start boom"));
      try {
        const result = await host.beginDesignPrompt(fileA, "Redesign settings", "Redesign settings");
        expect(result.started).toBe(false);
        expect(result.error).toMatch("pre-start boom");
        expect(result.design).toBeNull();
        expect(await loadDesignState(a.cwd, entry.sessionId)).toBeNull();
      } finally {
        promptSpy.mockRestore();
      }
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("beginDesignPrompt keeps the subject when the turn started then failed", async () => {
    const a = await makeProject("design-started");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      const entry = host.testSessions().get(fileA)!;
      const promptSpy = vi.spyOn(entry.runtime.session, "prompt").mockImplementation(async () => {
        entry.runtime.session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Redesign" }], timestamp: Date.now() });
        throw new Error("mid-turn boom");
      });
      try {
        const result = await host.beginDesignPrompt(fileA, "Redesign settings", "Redesign settings");
        expect(result.started).toBe(true);
        expect(result.error).toMatch("mid-turn boom");
        expect(result.design?.subject).toBe("Redesign settings");
        expect((await loadDesignState(a.cwd, entry.sessionId))?.subject).toBe("Redesign settings");
      } finally {
        promptSpy.mockRestore();
      }
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("beginDesignPrompt validates subject and session identity", async () => {
    const a = await makeProject("design-invalid");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await expect(host.beginDesignPrompt(fileA, "   ", "   ")).rejects.toThrow("invalid design subject");
      await expect(host.beginDesignPrompt(join(a.cwd, "nope.jsonl"), "Redesign", "Redesign")).rejects.toThrow();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("goal and design starts mutually exclude each other", async () => {
    const a = await makeProject("excl-host");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      const entry = host.testSessions().get(fileA)!;
      // Active design blocks goal starts (backend invariant, not just UI).
      await saveDesignState(a.cwd, entry.sessionId, createDesignState("Redesign", "redesign"));
      await expect(host.beginGoalPrompt(fileA, "Fix X", "Fix X")).rejects.toThrow(/design.*active/i);
      expect(await loadSessionGoal(a.cwd, entry.sessionId)).toBeNull();
      // Active goal blocks design starts.
      await clearDesignState(a.cwd, entry.sessionId);
      await saveSessionGoal(a.cwd, entry.sessionId, createDurableGoalState("Fix X", defaultDurableGoalModeConfig()));
      await expect(host.beginDesignPrompt(fileA, "Redesign", "Redesign")).rejects.toThrow(/goal.*active/i);
      expect(await loadDesignState(a.cwd, entry.sessionId)).toBeNull();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("execDesignCommand executes on the addressed session, not the foreground", async () => {
    const a = await makeProject("design-route-a");
    const b = await makeProject("design-route-b");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      await host.open({ path: fileB, cwd: b.cwd });
      expect(host.activeSessionFile).toBe(fileB);
      const delivered: string[] = [];
      for (const entry of host.testSessions().values()) {
        vi.spyOn(entry.runtime.session, "prompt").mockImplementation(async (message: string) => {
          delivered.push(`${entry.sessionFile}:${message}`);
        });
      }
      await host.execDesignCommand(fileA, "done");
      expect(delivered).toEqual([`${fileA}:/design done`]);
      expect(host.activeSessionFile).toBe(fileB);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("retains both runtimes across switches without teardown", async () => {
    const a = await makeProject("a");
    const b = await makeProject("b");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      expect(host.activeSessionFile).toBe(fileA);
      await host.open({ path: fileB, cwd: b.cwd });
      expect(host.activeSessionFile).toBe(fileB);
      const sessions = host.testSessions();
      expect(sessions.size).toBe(2);
      expect(sessions.has(fileA)).toBe(true);
      expect(sessions.has(fileB)).toBe(true);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("routes targeted operations to the addressed session only", async () => {
    const a = await makeProject("c");
    const b = await makeProject("d");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.open({ path: fileB, cwd: b.cwd });
      // Each project's chat owns its own execution slot (I1): mutations
      // require the addressed session to BE the owner, never the foreground.
      await host.activateExecution(a.cwd, fileA);
      await host.activateExecution(b.cwd, fileB);
      // Unknown model fails before touching anything: B keeps its state.
      await expect(host.setModel(fileB, "nope", "missing")).rejects.toThrow(/Model not found/);
      const stateB = await host.getState(fileB);
      expect(stateB.sessionFile).toBe(fileB);
      // Idle aborts resolve without affecting the other runtime.
      await host.abort(fileA);
      await host.abort(fileB);
      // A new same-project conversation TAKES the slot: A is released
      // (cold, disk-only) and A2 becomes project a's execution owner.
      const fileA2 = await makeSessionFile(a.cwd);
      await host.open({ path: fileA2, cwd: a.cwd });
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileA2);
      expect(host.testSessions().has(fileA)).toBe(false);
      // Mutations never auto-open or fall back to "whatever is foreground":
      // the retired address is rejected outright.
      await expect(host.compact(fileA)).rejects.toThrow(/runtime is not available/);
      // A turn is a mutation too: a cold historical path can never start one.
      await expect(host.prompt("hi", undefined, undefined, fileA)).rejects.toThrow(/runtime is not available/);
      // setModel has the same gate: a cold address is rejected, never
      // redirected to whichever session happens to own the project.
      await expect(host.setModel(fileA, "nope", "missing")).rejects.toThrow(/runtime is not available/);
      // Addressing the owner itself proceeds past the ownership gate.
      await expect(host.compact(fileA2)).rejects.toThrow(/Nothing to compact/);
      // One installed runtime per project — never a retained non-owner.
      expect(host.testSessions().size).toBe(2);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("routes an explicitly addressed prompt away from the foreground", async () => {
    const a = await makeProject("prompt-a");
    const b = await makeProject("prompt-b");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      await host.open({ path: fileB, cwd: b.cwd });
      expect(host.activeSessionFile).toBe(fileB);
      const delivered: string[] = [];
      for (const entry of host.testSessions().values()) {
        vi.spyOn(entry.runtime.session, "prompt").mockImplementation(async (message: string) => {
          delivered.push(`${entry.sessionFile}:${message}`);
        });
      }
      await host.prompt("hello A", undefined, undefined, fileA);
      expect(delivered).toEqual([`${fileA}:hello A`]);
      // Explicit identity never moves the foreground pointer.
      expect(host.activeSessionFile).toBe(fileB);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("a slow open never foregrounds over a faster later open", async () => {
    const a = await makeProject("slow-a");
    const b = await makeProject("fast-b");
    const { host, statuses } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileB, cwd: b.cwd }); // warm B: its re-open is the fast path.
      const slow = host.open({ path: fileA, cwd: a.cwd, requestId: 1 });
      const fast = host.open({ path: fileB, cwd: b.cwd, requestId: 2 });
      const [stateA, stateB] = await Promise.all([slow, fast]);
      // The slow runtime still builds (its state resolves), but the
      // foreground follows the last invocation, not the last completion.
      expect(stateA.sessionFile).toBe(fileA);
      expect(stateB.sessionFile).toBe(fileB);
      expect(host.activeSessionFile).toBe(fileB);
      // No ready emission for the superseded open: the renderer never sees
      // a foreground claim for A.
      const readyFor = statuses
        .filter((s) => s.status === "ready")
        .map((s) => s.sessionPath);
      expect(readyFor[readyFor.length - 1]).toBe(fileB);
      expect(readyFor).not.toContain(fileA);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("protects the owner from direct release; deactivation is the release path", async () => {
    const a = await makeProject("e");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      // R3: releaseSession may never strip a project of its execution owner.
      expect(await host.releaseSession(fileA)).toBe(false);
      expect(host.testSessions().has(fileA)).toBe(true);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileA);

      // Deactivation cold-stores the project: the runtime goes, the disk
      // transcript stays, and no replacement is built (R2/R4).
      const before = host.testRuntimeCreationCount();
      expect(await host.deactivateExecution(a.cwd, fileA)).toBe(true);
      expect(host.testSessions().size).toBe(0);
      expect(host.testExecutionByCwd().has(a.cwd)).toBe(false);
      expect(host.testRuntimeCreationCount()).toBe(before);
      host.testAssertRetentionInvariant();

      // With no owner left the same file is releasable/no-op, and unknown
      // paths are harmless.
      expect(await host.releaseSession(fileA)).toBe(true);
      expect(await host.releaseSession("/nonexistent.json")).toBe(true);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("a release racing reactivation aborts instead of pulling a live runtime", async () => {
    const a = await makeProject("race-a");
    const b = await makeProject("race-b");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.open({ path: fileB, cwd: b.cwd });
      expect(host.activeSessionFile).toBe(fileB);

      // Gate the thread scan inside deactivateExecution(A) so a concurrent
      // addressed read lands mid-scan: without post-await lifecycle
      // revalidation the gated release would dispose A out from under a
      // caller that is actively reading it.
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      let gated = false;
      let scans = 0;
      const scan = vi
        .spyOn(host as unknown as { hasActiveThreadsForSession: (id: string) => Promise<boolean> }, "hasActiveThreadsForSession")
        .mockImplementation(async () => {
          // The first scan is the busy pre-check; the SECOND is the
          // await-crossing release scan whose post-await revalidation is
          // under test here.
          scans += 1;
          if (scans === 2 && !gated) {
            gated = true;
            await gate;
          }
          return false;
        });
      try {
        const releasing = host.deactivateExecution(a.cwd, fileA);
        await vi.waitFor(() => expect(gated).toBe(true));
        // The read touches A's lifecycle while deactivation is still scanning.
        const stateA = await host.getState(fileA);
        expect(stateA.sessionFile).toBe(fileA);
        releaseGate();
        // The release must refuse, never dispose a live runtime.
        expect(await releasing).toBe(false);
        expect(host.testSessions().has(fileA)).toBe(true);
        expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileA);
      } finally {
        scan.mockRestore();
      }
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("a release racing an addressed prompt aborts before streaming flips", async () => {
    const a = await makeProject("race-prompt-a");
    const b = await makeProject("race-prompt-b");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.open({ path: fileB, cwd: b.cwd });
      await host.activateExecution(b.cwd, fileB);

      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      let gated = false;
      let scans = 0;
      const scan = vi
        .spyOn(host as unknown as { hasActiveThreadsForSession: (id: string) => Promise<boolean> }, "hasActiveThreadsForSession")
        .mockImplementation(async () => {
          // Gate the release scan (the second one), not the busy pre-check.
          scans += 1;
          if (scans === 2 && !gated) {
            gated = true;
            await gate;
          }
          return false;
        });
      const delivered: string[] = [];
      const entryB = host.testSessions().get(fileB)!;
      const promptSpy = vi.spyOn(entryB.runtime.session, "prompt").mockImplementation(async (message: string) => {
        delivered.push(`${entryB.sessionFile}:${message}`);
      });
      try {
        const releasing = host.deactivateExecution(b.cwd, fileB);
        await vi.waitFor(() => expect(gated).toBe(true));
        // The addressed prompt touches B's lifecycle synchronously at start —
        // before isStreaming flips — so the gated release must still abort.
        await host.prompt("hello B", undefined, undefined, fileB);
        releaseGate();
        expect(await releasing).toBe(false);
        expect(delivered).toEqual([`${fileB}:hello B`]);
        expect(host.testSessions().has(fileB)).toBe(true);
        expect(host.testExecutionByCwd().get(b.cwd)).toBe(fileB);
      } finally {
        scan.mockRestore();
        promptSpy.mockRestore();
      }
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("keeps per-project model runtimes isolated", async () => {
    const a = await makeProject("f");
    const b = await makeProject("g");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.open({ path: fileB, cwd: b.cwd });
      const projects = host.testProjectRuntimes();
      expect([...projects.keys()].sort()).toEqual([a.cwd, b.cwd].sort());
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("reactivation skips the reparse while the transcript is unchanged", async () => {
    const a = await makeProject("fingerprint-a");
    const b = await makeProject("fingerprint-b");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    const openSpy = vi.spyOn(SessionManager, "open");
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.open({ path: fileB, cwd: b.cwd });
      // Force fileA onto disk (new sessions start as unflushed future
      // paths). The SDK only persists once an assistant message exists
      // (user-only prefixes wait for the turn), so append both and persist
      // the assistant entry — this materializes a parseable transcript, and
      // later activations have a real fingerprint to compare against.
      const managerA = host.testSessions().get(fileA)!.runtime.session.sessionManager;
      managerA.appendMessage({
        role: "user",
        content: [{ type: "text", text: "seed" }],
        timestamp: Date.now(),
      });
      const seedAssistantId = managerA.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "seeded" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      (managerA as unknown as { _persist: (entry: unknown) => void })._persist(managerA.getEntry(seedAssistantId));
      // Same-owner activation is a structural no-op: no rebuild, no reparse.
      openSpy.mockClear();
      await host.open({ path: fileA, cwd: a.cwd });
      expect(host.activeSessionFile).toBe(fileA);
      expect(openSpy).not.toHaveBeenCalled();
      // A → B → A is no different: A never stopped being project a's owner,
      // so it is never torn down and re-parsed.
      await host.open({ path: fileB, cwd: b.cwd });
      await host.open({ path: fileA, cwd: a.cwd });
      expect(host.activeSessionFile).toBe(fileA);
      expect(openSpy).not.toHaveBeenCalled();
      // An external append is pulled by the EXPLICIT disk sync, never as a
      // side effect of activation.
      const future = new Date(Date.now() + 30_000);
      await utimes(fileA, future, future);
      openSpy.mockClear();
      expect(await host.refreshFromDisk(fileA)).toBe(true);
      expect(openSpy).toHaveBeenCalled();
      // An unchanged transcript skips the reparse entirely.
      openSpy.mockClear();
      expect(await host.refreshFromDisk(fileA)).toBe(true);
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      await host.dispose();
    }
  }, 60_000);

  it("a cold build racing an append does not record it as ingested", async () => {
    const a = await makeProject("race-build-a");
    const b = await makeProject("race-build-b");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    const origOpen = SessionManager.open.bind(SessionManager);
    const openSpy = vi.spyOn(SessionManager, "open");
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.open({ path: fileB, cwd: b.cwd });
      const managerA = host.testSessions().get(fileA)!.runtime.session.sessionManager;
      managerA.appendMessage({
        role: "user",
        content: [{ type: "text", text: "seed" }],
        timestamp: Date.now(),
      });
      const seedAssistantId = managerA.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "seeded" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      (managerA as unknown as { _persist: (entry: unknown) => void })._persist(managerA.getEntry(seedAssistantId));
      // Cold-store the project so the next claim takes the cold creation
      // path, then land an append DURING the async build (after
      // SessionManager.open read it). The seed must be the pre-read
      // fingerprint: the raced append then mismatches on the next sync.
      expect(await host.deactivateExecution(a.cwd, fileA)).toBe(true);
      const raced = new Date(Date.now() + 60_000);
      openSpy.mockImplementationOnce((...args: Parameters<typeof SessionManager.open>) => {
        const manager = origOpen(...args);
        utimesSync(fileA, raced, raced);
        return manager;
      });
      await host.open({ path: fileA, cwd: a.cwd });
      expect(host.activeSessionFile).toBe(fileA);
      expect(openSpy).toHaveBeenCalled();
      // The raced append was NOT recorded as ingested: the next sync sees
      // the mismatch and re-parses instead of going invisible.
      openSpy.mockClear();
      expect(await host.refreshFromDisk(fileA)).toBe(true);
      expect(openSpy).toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      await host.dispose();
    }
  }, 60_000);

  it("an append racing the sync is not recorded as ingested", async () => {
    const a = await makeProject("race-append-a");
    const b = await makeProject("race-append-b");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    const origOpen = SessionManager.open.bind(SessionManager);
    const openSpy = vi.spyOn(SessionManager, "open");
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.open({ path: fileB, cwd: b.cwd });
      const managerA = host.testSessions().get(fileA)!.runtime.session.sessionManager;
      managerA.appendMessage({
        role: "user",
        content: [{ type: "text", text: "seed" }],
        timestamp: Date.now(),
      });
      const seedAssistantId = managerA.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "seeded" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      (managerA as unknown as { _persist: (entry: unknown) => void })._persist(managerA.getEntry(seedAssistantId));
      // Force a sync during which a second append lands mid-read (mtime
      // bump inside SessionManager.open). The stored fingerprint must be the
      // pre-read one, so the raced append mismatches on the following sync
      // and re-parses — never goes invisible.
      await utimes(fileA, new Date(Date.now() + 30_000), new Date(Date.now() + 30_000));
      const raced = new Date(Date.now() + 60_000);
      openSpy.mockImplementationOnce((...args: Parameters<typeof SessionManager.open>) => {
        utimesSync(fileA, raced, raced);
        return origOpen(...args);
      });
      expect(await host.refreshFromDisk(fileA)).toBe(true);
      openSpy.mockClear();
      expect(await host.refreshFromDisk(fileA)).toBe(true);
      expect(openSpy).toHaveBeenCalled();
      // …and then converges: the following sync has nothing to do.
      openSpy.mockClear();
      expect(await host.refreshFromDisk(fileA)).toBe(true);
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      await host.dispose();
    }
  }, 60_000);

  it("a superseded activation never commits or emits after newer work", async () => {
    const a = await makeProject("act-a");
    const b = await makeProject("act-b");
    const { host, statuses } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.open({ path: fileB, cwd: b.cwd });
      statuses.length = 0;

      // Gate the FIRST rollback-leaf restore (A's activation prep) so B's
      // activation fully completes while A is still awaiting preparation.
      // A and B live in different projects (independent ownership), so both
      // activations are in flight at once; a stale ready from A would be
      // accepted by the renderer — it must never be sent.
      const origLoad = RollbackStore.prototype.load;
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      let gated = false;
      const load = vi.spyOn(RollbackStore.prototype, "load").mockImplementation(async function (
        this: RollbackStore,
        ...args: Parameters<RollbackStore["load"]>
      ) {
        if (!gated) {
          gated = true;
          await gate;
        }
        return origLoad.apply(this, args);
      });
      try {
        const slowA = host.open({ path: fileA, cwd: a.cwd });
        // Let A's activation reach the gated restore before B starts.
        await vi.waitFor(() => expect(gated).toBe(true));
        await host.open({ path: fileB, cwd: b.cwd });
        expect(host.activeSessionFile).toBe(fileB);
        releaseGate();
        await slowA;
        // B's foreground stands; A emitted nothing (no stale ready).
        expect(host.activeSessionFile).toBe(fileB);
        const readies = statuses.filter((s) => s.status === "ready").map((s) => s.sessionPath);
        expect(readies).toEqual([fileB]);
      } finally {
        load.mockRestore();
      }
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("retains exactly one runtime per project: each activation transfers the slot", async () => {
    const { cwd, agentDir } = await makeProject("retain");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    try {
      const files: string[] = [];
      for (let i = 0; i < 11; i++) {
        const file = await makeSessionFile(cwd);
        files.push(file);
        await host.open({ path: file, cwd });
        // Every open transfers the project's slot: one installed runtime,
        // owned by the newest file, and every evicted-away file is cold
        // (disk-only) with zero AgentSession memory (R1/R2/R6).
        expect(host.testSessions().size).toBe(1);
        expect(host.testExecutionByCwd().size).toBe(1);
        expect(host.testExecutionByCwd().get(cwd)).toBe(file);
        host.testAssertRetentionInvariant();
        for (const gone of files.slice(0, -1)) {
          expect(host.testSessions().has(gone)).toBe(false);
          await expect(host.getState(gone)).rejects.toThrow(/runtime is not available/);
        }
      }
      // No LRU cap remains: retention is exactly the owner count.
      expect(host.testSessions().size).toBe(1);
      expect(host.testRuntimeCreationCount()).toBe(11);
    } finally {
      await host.dispose();
    }
  }, 120_000);

  it("retains one runtime per project across many projects", async () => {
    const projects = [];
    for (let i = 0; i < 9; i++) projects.push(await makeProject(`retain-many-${i}`));
    const { host } = makeHost(projects[0]!.cwd, projects[0]!.agentDir);
    await host.start();
    try {
      const owners: string[] = [];
      for (const p of projects) {
        const file = await makeSessionFile(p.cwd);
        owners.push(file);
        await host.open({ path: file, cwd: p.cwd });
        host.testAssertRetentionInvariant();
      }
      // 9 projects → 9 installed owners, one each, no global cap.
      expect(host.testSessions().size).toBe(9);
      expect(host.testExecutionByCwd().size).toBe(9);
      for (const [i, p] of projects.entries()) {
        expect(host.testExecutionByCwd().get(p.cwd)).toBe(owners[i]);
      }
    } finally {
      await host.dispose();
    }
  }, 120_000);

  it("checkpoints a background turn against its own project, not the foreground", async () => {
    const a = await makeProject("turn-a");
    const b = await makeProject("turn-b");
    for (const p of [a, b]) {
      await exec("git", ["init"], { cwd: p.cwd });
      await writeFile(join(p.cwd, "file.txt"), "before\n");
      await exec("git", ["add", "file.txt"], { cwd: p.cwd });
    }
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      await host.open({ path: fileB, cwd: b.cwd });
      expect(host.activeSessionFile).toBe(fileB);

      // Both projects warmed by their opens: no warm captures can leak into
      // the assertion below. Call-through spy; filter authoritative
      // checkpoint captures after the fact.
      const capture = vi.spyOn(SnapshotStore.prototype, "capture");
      try {
        await host.activateExecution(b.cwd, fileB);
        const start = await host.testCaptureTurnStart(fileB);
        if (!start || "skipped" in start) throw new Error("expected a turn checkpoint");
        // The turn's own messages land in B's transcript while it runs.
        const managerB = host.testSessions().get(fileB)!.runtime.session.sessionManager;
        managerB.appendMessage({
          role: "user",
          content: [{ type: "text", text: "change b" }],
          timestamp: Date.now(),
        });
        managerB.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "changed" }],
          api: "test",
          provider: "test",
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        });
        // Foreground moves mid-turn; the checkpoint must still finish
        // against B's project.
        await host.open({ path: fileA, cwd: a.cwd });
        expect(host.activeSessionFile).toBe(fileA);
        await host.testCaptureTurnEnd(start, fileB);
        // Pre-turn + post-turn captures, both B's cwd — never the
        // foreground's. (Failing shape: [cwdB, cwdA].)
        const authoritative = capture.mock.calls
          .filter((call) => (call[1] as { authoritative?: boolean } | undefined)?.authoritative === true)
          .map((call) => call[0]);
        expect(authoritative).toEqual([b.cwd, b.cwd]);
      } finally {
        capture.mockRestore();
      }
    } finally {
      await host.dispose();
    }
  }, 120_000);
});

describe("PiHost.renameSession", () => {
  const seedPersistedFile = async (host: PiHost, cwd: string): Promise<string> => {
    const file = await makeSessionFile(cwd);
    await host.open({ path: file, cwd });
    const manager = host.testSessions().get(file)!.runtime.session.sessionManager;
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "seed" }], timestamp: Date.now() });
    const assistantId = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seeded" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    (manager as unknown as { _persist: (entry: unknown) => void })._persist(manager.getEntry(assistantId));
    return file;
  };

  it("renames a retained-idle session without moving the foreground", async () => {
    const a = await makeProject("rename-a");
    const b = await makeProject("rename-b");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await seedPersistedFile(host, a.cwd);
      const fileB = await seedPersistedFile(host, b.cwd);
      await host.open({ path: fileB, cwd: b.cwd });
      expect(host.activeSessionFile).toBe(fileB);
      await host.renameSession(fileA, "Idle chat");
      expect(host.testSessions().get(fileA)!.runtime.session.sessionManager.getSessionName()).toBe("Idle chat");
      expect(host.activeSessionFile).toBe(fileB);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("renames a never-opened session without creating a runtime", async () => {
    const a = await makeProject("rename-cold");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const file = await seedPersistedFile(host, a.cwd);
      // The seeded file briefly owned the project; cold-storing it leaves
      // the project with no runtime and no execution record.
      expect(await host.deactivateExecution(a.cwd, file)).toBe(true);
      expect(host.testSessions().size).toBe(0);
      expect(host.testExecutionByCwd().size).toBe(0);
      await host.renameSession(file, "Cold chat");
      expect(host.testSessions().size).toBe(0);
      expect(host.activeSessionFile).toBeNull();
      expect(SessionManager.open(file, undefined, a.cwd).getSessionName()).toBe("Cold chat");
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("rejects unknown paths and blank names", async () => {
    const a = await makeProject("rename-bad");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      await expect(host.renameSession(join(a.cwd, "nope.jsonl"), "x")).rejects.toThrow();
      const file = await makeSessionFile(a.cwd);
      await expect(host.renameSession(file, "")).rejects.toThrow("invalid session name");
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("drain for restart", () => {
  function liveSession(streaming: boolean): SessionEntry {
    // The drain path only reads isStreaming/sessionId; the fake carries
    // exactly that (mutable here, readonly on the real session).
    return {
      runtime: { session: { isStreaming: streaming, sessionId: "s1" } },
    } as unknown as SessionEntry;
  }

  it("refuses new turns once draining, before touching sessions", async () => {
    const { cwd, agentDir } = await makeProject("drain-fence");
    const { host } = makeHost(cwd, agentDir);
    expect(host.isDraining()).toBe(false);
    host.beginDrain();
    expect(host.isDraining()).toBe(true);
    await expect(host.prompt("hi", undefined, undefined, "/tmp/drain.jsonl")).rejects.toThrow(/draining/);
    await host.dispose();
  });

  it("is quiet with no sessions and times out on a live turn", async () => {
    const { cwd, agentDir } = await makeProject("drain-quiet");
    const { host } = makeHost(cwd, agentDir);
    expect(host.activeTurnCount()).toBe(0);
    expect(await host.drainTurns(50)).toBe(true);
    host.testSessions().set("f", liveSession(true));
    expect(host.activeTurnCount()).toBe(1);
    expect(await host.drainTurns(60)).toBe(false);
    await host.dispose();
  });

  it("returns true when the turn ends mid-wait", async () => {
    const { cwd, agentDir } = await makeProject("drain-finish");
    const { host } = makeHost(cwd, agentDir);
    let streaming = true;
    const fake = {
      runtime: { session: { get isStreaming() { return streaming; }, sessionId: "s1" } },
    } as unknown as SessionEntry;
    host.testSessions().set("f", fake);
    setTimeout(() => {
      streaming = false;
    }, 20);
    expect(await host.drainTurns(1000)).toBe(true);
    expect(host.activeTurnCount()).toBe(0);
    await host.dispose();
  });

  it("counts approval-blocked sessions as live", async () => {
    const { cwd, agentDir } = await makeProject("drain-ui");
    const { host } = makeHost(cwd, agentDir);
    host.testSessions().set("f", liveSession(false));
    expect(host.activeTurnCount()).toBe(0);
    host.testUiRequests().set("u1", { sessionFile: "f", sessionId: null, resolve: () => undefined, reject: () => undefined });
    expect(host.activeTurnCount()).toBe(1);
    await host.dispose();
  });
});

describe("instance session fork", () => {
  async function scopedRoot(tag: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `pideck-sessions-${tag}-`));
    roots.push(dir);
    return dir;
  }

  async function mintSession(cwd: string, root: string): Promise<string> {
    const sm = SessionManager.create(cwd, root);
    const file = sm.getSessionFile();
    if (!file) throw new Error("no session file");
    // SessionManager mints the path lazily; materialize it so reads behave.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, "");
    return file;
  }

  it("opens sessions inside its root and refuses outside files", async () => {
    const { cwd, agentDir } = await makeProject("fork");
    const root = await scopedRoot("fork");
    const inside = await mintSession(cwd, root);
    expect(inside.startsWith(root)).toBe(true);
    const outside = await mintSession(cwd, await scopedRoot("other"));
    const { host } = makeHost(cwd, agentDir, root);
    await host.start();
    try {
      await host.open({ path: inside, cwd });
      expect(host.testForegroundSessionFile()).toBe(inside);
      await expect(host.open({ path: outside, cwd })).rejects.toThrow(/outside/i);
    } finally {
      await host.dispose();
    }
  });

  it("resolves parents only inside the given root", async () => {
    const { cwd } = await makeProject("parents");
    const root = await scopedRoot("parents");
    const file = await mintSession(cwd, root);
    const id = file.split("_").pop()!.replace(/\.jsonl$/, "");
    const { resolveParentSessionFile } = await import("./threads");
    expect(await resolveParentSessionFile(id, root)).toBe(file);
    expect(await resolveParentSessionFile(id)).toBeNull();
  });
});
