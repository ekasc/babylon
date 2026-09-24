import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost, type HostOptions, type SessionEntry } from "./pi-host";
import { ProjectExecutionBusyError } from "../src/execution";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-retain-${tag}-`));
  const agentDir = await mkdtemp(join(tmpdir(), `pideck-retain-agent-${tag}-`));
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
  const host = new PiHost({
    cwd,
    agentDir,
    stateDir: join(agentDir, "pideck-state"),
    onEvent: () => undefined,
  });
  return { host };
}

/** Drive Pi's INTERNAL switch callback (private execution handoff) in tests. */
async function stageHandoff(host: PiHost, sourceFile: string, targetFile: string): Promise<void> {
  const source = host.testSessions().get(sourceFile);
  if (!source) throw new Error("source runtime is not installed");
  const seam = host as unknown as {
    stageExecutionHandoff(entry: SessionEntry, sessionPath: string, options?: { cwdOverride?: string }): Promise<unknown>;
  };
  await seam.stageExecutionHandoff(source, targetFile);
}

function setStreaming(host: PiHost, sessionFile: string, value: boolean): void {
  Object.defineProperty(host.testSessions().get(sessionFile)!.runtime.session, "isStreaming", {
    value,
    configurable: true,
  });
}

describe("C10 retention: one installed execution runtime per project", () => {
  it("baseline: activating A installs A and records the project owner", async () => {
    const a = await makeProject("baseline");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.activateExecution(a.cwd, fileA);
      expect([...host.testSessions().keys()]).toEqual([fileA]);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileA);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("idle transfer disposes A, installs B, and keeps exactly one project entry", async () => {
    const a = await makeProject("transfer");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(a.cwd);
      await host.activateExecution(a.cwd, fileA);
      const entryA = host.testSessions().get(fileA)!;

      const createdBefore = host.testRuntimeCreationCount();
      await host.activateExecution(a.cwd, fileB);

      // A's runtime is gone (disposed, not merely unindexed) and B owns P.
      expect(host.testSessions().has(fileA)).toBe(false);
      expect(host.testSessions().size).toBe(1);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileB);
      expect(host.testRuntimeCreationCount()).toBe(createdBefore + 1);
      // A is cold: reads that do not need a runtime still work, runtime reads
      // reject without resurrecting it.
      await expect(host.getState(fileA)).rejects.toThrow(/runtime is not available/);
      expect(host.testSessions().size).toBe(1);
      expect(entryA.sessionFile).toBe(fileA);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("busy owner rejects the activation without ever creating the target", async () => {
    const a = await makeProject("busy");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(a.cwd);
      await host.activateExecution(a.cwd, fileA);
      const entryA = host.testSessions().get(fileA)!;
      setStreaming(host, fileA, true);

      const createdBefore = host.testRuntimeCreationCount();
      await expect(host.activateExecution(a.cwd, fileB)).rejects.toBeInstanceOf(ProjectExecutionBusyError);
      // B's runtime was never built, A is the exact same object, and the
      // installed count is unchanged.
      expect(host.testRuntimeCreationCount()).toBe(createdBefore);
      expect(host.testSessions().get(fileA)).toBe(entryA);
      expect(host.testSessions().has(fileB)).toBe(false);
      expect(host.testSessions().size).toBe(1);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileA);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("a target build failure leaves the previous owner installed and usable", async () => {
    const a = await makeProject("build-fail");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(a.cwd);
      await host.activateExecution(a.cwd, fileA);
      const entryA = host.testSessions().get(fileA)!;
      const build = vi
        .spyOn(host as unknown as { buildSessionForCwd: (file: string, cwd: string) => Promise<SessionEntry> }, "buildSessionForCwd")
        .mockRejectedValueOnce(new Error("candidate build exploded"));

      await expect(host.activateExecution(a.cwd, fileB)).rejects.toThrow(/candidate build exploded/);
      expect(host.testSessions().get(fileA)).toBe(entryA);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileA);
      // A is still fully usable: its own state resolves.
      expect((await host.getState(fileA)).sessionFile).toBe(fileA);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("an owner that goes busy during the target build keeps its runtime and rejects", async () => {
    const a = await makeProject("goes-busy");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(a.cwd);
      await host.activateExecution(a.cwd, fileA);
      const entryA = host.testSessions().get(fileA)!;

      // A goes busy while B is being built (the build is async, so the
      // recheck immediately before replacement is the only thing that sees it).
      const origBuild = (host as unknown as { buildSessionForCwd: (file: string, cwd: string) => Promise<SessionEntry> })
        .buildSessionForCwd.bind(host);
      let goBusy: (() => void) | null = null;
      const built = new Promise<void>((resolve) => { goBusy = resolve; });
      vi.spyOn(host as unknown as { buildSessionForCwd: (file: string, cwd: string) => Promise<SessionEntry> }, "buildSessionForCwd")
        .mockImplementation(async (file, cwd) => {
          const candidate = await origBuild(file, cwd);
          goBusy?.();
          await built;
          return candidate;
        });

      const pending = host.activateExecution(a.cwd, fileB);
      await vi.waitFor(() => expect(goBusy).not.toBeNull());
      setStreaming(host, fileA, true);

      await expect(pending).rejects.toBeInstanceOf(ProjectExecutionBusyError);
      // The detached candidate is disposed, the busy owner survives intact.
      expect(host.testSessions().get(fileA)).toBe(entryA);
      expect(host.testSessions().has(fileB)).toBe(false);
      expect(host.testSessions().size).toBe(1);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileA);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("concurrent same-project activations converge on exactly one owner", async () => {
    const a = await makeProject("concurrent");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(a.cwd);
      const fileC = await makeSessionFile(a.cwd);
      // The builds are delayed so the requests genuinely overlap.
      const origBuild = (host as unknown as { buildSessionForCwd: (file: string, cwd: string) => Promise<SessionEntry> })
        .buildSessionForCwd.bind(host);
      vi.spyOn(host as unknown as { buildSessionForCwd: (file: string, cwd: string) => Promise<SessionEntry> }, "buildSessionForCwd")
        .mockImplementation(async (file, cwd) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return origBuild(file, cwd);
        });

      const results = await Promise.allSettled([
        host.activateExecution(a.cwd, fileA),
        host.activateExecution(a.cwd, fileB),
        host.activateExecution(a.cwd, fileC),
      ]);
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      // Last invocation wins, and no orphan runtime survives the race.
      expect(host.testSessions().size).toBe(1);
      expect(host.testExecutionByCwd().size).toBe(1);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileC);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("cross-project activations keep one entry per project", async () => {
    const a = await makeProject("cross-a");
    const b = await makeProject("cross-b");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.activateExecution(a.cwd, fileA);
      await host.activateExecution(b.cwd, fileB);
      expect(host.testSessions().has(fileA)).toBe(true);
      expect(host.testSessions().has(fileB)).toBe(true);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileA);
      expect(host.testExecutionByCwd().get(b.cwd)).toBe(fileB);
      expect(host.testSessions().size).toBe(2);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("100 historical reads create zero runtimes", async () => {
    const a = await makeProject("history");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.activateExecution(a.cwd, fileA);
      // 100 other conversations in the same project, all on disk.
      const history: string[] = [];
      for (let i = 0; i < 100; i++) history.push(await makeSessionFile(a.cwd));

      const createdBefore = host.testRuntimeCreationCount();
      for (const file of history) {
        const turns = await host.getHistory(file);
        expect(Array.isArray(turns.turns)).toBe(true);
      }
      // Reading history never materializes an AgentSession.
      expect(host.testRuntimeCreationCount()).toBe(createdBefore);
      expect(host.testSessions().size).toBe(1);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileA);
      for (const file of history) {
        expect(host.testSessions().has(file)).toBe(false);
        expect(host.sessionCwdFor(file)).toBeNull();
      }
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 120_000);

  it("steady state: installed runtimes and the ownership index are the same identities", async () => {
    const projects = [await makeProject("steady-1"), await makeProject("steady-2"), await makeProject("steady-3")];
    const { host } = makeHost(projects[0]!.cwd, projects[0]!.agentDir);
    await host.start();
    try {
      for (const [i, p] of projects.entries()) {
        const file = await makeSessionFile(p.cwd);
        await host.activateExecution(p.cwd, file);
        // A few same-project switches, so the index has moved before we
        // compare identities.
        const later = await makeSessionFile(p.cwd);
        await host.activateExecution(p.cwd, later);
        expect(host.testExecutionByCwd().get(p.cwd)).toBe(later);
        expect(host.testSessions().get(later)?.cwd).toBe(p.cwd);
        expect(i).toBeGreaterThanOrEqual(0);
      }
      const installed = new Set(host.testSessions().keys());
      const owned = new Set(host.testExecutionByCwd().values());
      expect(installed.size).toBe(3);
      expect([...owned].sort()).toEqual([...installed].sort());
      for (const [cwd, file] of host.testExecutionByCwd()) {
        expect(host.testSessions().get(file)?.cwd).toBe(cwd);
      }
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("C10 retention: deactivation is a cold-store, not an eviction", () => {
  it("deactivation removes the runtime and ownership but leaves the transcript readable", async () => {
    const a = await makeProject("deactivate");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.activateExecution(a.cwd, fileA);

      const createdBefore = host.testRuntimeCreationCount();
      expect(await host.deactivateExecution(a.cwd, fileA)).toBe(true);
      expect(host.testSessions().has(fileA)).toBe(false);
      expect(host.testExecutionByCwd().has(a.cwd)).toBe(false);
      expect(host.testRuntimeCreationCount()).toBe(createdBefore);

      // Cold reads still work…
      expect(Array.isArray((await host.getHistory(fileA)).turns)).toBe(true);
      // …runtime reads reject and never resurrect the runtime.
      await expect(host.getState(fileA)).rejects.toThrow(/runtime is not available/);
      await expect(host.getStats(fileA)).rejects.toThrow(/runtime is not available/);
      expect(host.testSessions().size).toBe(0);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("a streaming owner is never deactivated", async () => {
    const a = await makeProject("deactivate-busy");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.activateExecution(a.cwd, fileA);
      const entryA = host.testSessions().get(fileA)!;
      setStreaming(host, fileA, true);
      expect(await host.deactivateExecution(a.cwd, fileA)).toBe(false);
      expect(host.testSessions().get(fileA)).toBe(entryA);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileA);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("C10 retention: relocation rebuilds cwd-bound runtime state", () => {
  it("relocation moves ownership and rebuilds the runtime under the target cwd", async () => {
    const from = await makeProject("reloc-from");
    const to = await makeProject("reloc-to");
    const { host } = makeHost(from.cwd, from.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(from.cwd);
      await host.activateExecution(from.cwd, fileA);
      const original = host.testSessions().get(fileA)!;

      const relocated = await host.relocateExecution(fileA, from.cwd, to.cwd);
      // The runtime is a NEW object whose services and cwd are the target's.
      expect(relocated).not.toBe(original);
      expect(relocated.cwd).toBe(to.cwd);
      expect(relocated.services.cwd).toBe(to.cwd);
      // The old project has neither runtime nor owner; the new one has both.
      expect(host.testSessions().has(fileA)).toBe(true);
      expect(host.testSessions().get(fileA)).toBe(relocated);
      expect(host.testExecutionByCwd().has(from.cwd)).toBe(false);
      expect(host.testExecutionByCwd().get(to.cwd)).toBe(fileA);
      expect(host.testSessions().size).toBe(1);
      host.testAssertRetentionInvariant();

      // The relocated runtime is immediately usable for the new project.
      const delivered: string[] = [];
      vi.spyOn(relocated.runtime.session, "prompt").mockImplementation(async (message: string) => {
        delivered.push(message);
      });
      await host.prompt("worktree turn", undefined, undefined, fileA);
      expect(delivered).toEqual(["worktree turn"]);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("a failed relocation leaves the original project fully intact", async () => {
    const from = await makeProject("reloc-fail-from");
    const to = await makeProject("reloc-fail-to");
    const { host } = makeHost(from.cwd, from.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(from.cwd);
      await host.activateExecution(from.cwd, fileA);
      const original = host.testSessions().get(fileA)!;
      const build = vi
        .spyOn(host as unknown as { buildSessionForCwd: (file: string, cwd: string) => Promise<SessionEntry> }, "buildSessionForCwd")
        .mockRejectedValueOnce(new Error("target build failed"));

      await expect(host.relocateExecution(fileA, from.cwd, to.cwd)).rejects.toThrow(/relocation failed/);
      // Transactional: source runtime and ownership are untouched, and the
      // target project has nothing installed.
      expect(host.testSessions().get(fileA)).toBe(original);
      expect(host.testExecutionByCwd().get(from.cwd)).toBe(fileA);
      expect(host.testExecutionByCwd().has(to.cwd)).toBe(false);
      expect(host.testSessions().size).toBe(1);
      expect((await host.getState(fileA)).sessionFile).toBe(fileA);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("C10 retention: Pi fork/clone handoffs converge", () => {
  it("a successful clone hands the project to the target and disposes the source", async () => {
    const a = await makeProject("clone-ok");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.activateExecution(a.cwd, fileA);
      const entryA = host.testSessions().get(fileA)!;
      const target = await makeSessionFile(a.cwd);
      // Pi signals the switch from inside fork(); that is the handoff trigger.
      vi.spyOn(entryA.runtime, "fork").mockImplementation(async () => {
        await stageHandoff(host, fileA, target);
        return { cancelled: false, selectedText: "forked" };
      });

      const result = await host.clone(fileA);
      expect(result.cancelled).toBe(false);
      expect(result.sessionFile).toBe(target);
      // Source + target are never both installed.
      expect(host.testSessions().has(fileA)).toBe(false);
      expect(host.testSessions().size).toBe(1);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(target);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("a cancelled clone disposes the transient target and keeps the source", async () => {
    const a = await makeProject("clone-cancel");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.activateExecution(a.cwd, fileA);
      const entryA = host.testSessions().get(fileA)!;
      const target = await makeSessionFile(a.cwd);
      vi.spyOn(entryA.runtime, "fork").mockImplementation(async () => {
        // The target transient exists for a moment, then the user cancels.
        await stageHandoff(host, fileA, target);
        return { cancelled: true };
      });

      const result = await host.clone(fileA);
      expect(result.cancelled).toBe(true);
      expect(host.testSessions().get(fileA)).toBe(entryA);
      expect(host.testSessions().has(target)).toBe(false);
      expect(host.testSessions().size).toBe(1);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileA);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("a source that goes busy during a handoff keeps the project", async () => {
    const a = await makeProject("clone-busy");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.activateExecution(a.cwd, fileA);
      const entryA = host.testSessions().get(fileA)!;
      const target = await makeSessionFile(a.cwd);
      vi.spyOn(entryA.runtime, "fork").mockImplementation(async () => {
        await stageHandoff(host, fileA, target);
        // The source starts streaming while the handoff is still staged.
        setStreaming(host, fileA, true);
        return { cancelled: false, selectedText: "forked" };
      });

      const result = await host.clone(fileA);
      expect(result.cancelled).toBe(true);
      expect(host.testSessions().get(fileA)).toBe(entryA);
      expect(host.testSessions().has(target)).toBe(false);
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(fileA);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("C11: Pi's internal switch is a private, source-bound handoff", () => {
  it("stays in the SOURCE project even when the host booted in another cwd", async () => {
    const bootstrap = await makeProject("handoff-bootstrap");
    const a = await makeProject("handoff-a");
    const b = await makeProject("handoff-b");
    // The host was constructed for `bootstrap`, and project B also has an
    // owner. An internal switch from A must touch NEITHER: no host-global cwd
    // may leak into a handoff (C8/E).
    const { host } = makeHost(bootstrap.cwd, bootstrap.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      const fileB = await makeSessionFile(b.cwd);
      await host.activateExecution(a.cwd, fileA);
      await host.activateExecution(b.cwd, fileB);
      const target = await makeSessionFile(a.cwd);

      const source = host.testSessions().get(fileA)!;
      const seam = host as unknown as {
        stageExecutionHandoff(entry: SessionEntry, sessionPath: string, options?: { cwdOverride?: string }): Promise<unknown>;
      };
      // Outside a fork/clone the handoff finalizes immediately: the source's
      // project changes owner, and nothing else does.
      await seam.stageExecutionHandoff(source, target);

      // A's project handed over; B and the bootstrap cwd are untouched.
      expect(host.testExecutionByCwd().get(a.cwd)).toBe(target);
      expect(host.testExecutionByCwd().get(b.cwd)).toBe(fileB);
      expect(host.testSessions().has(fileA)).toBe(false);
      expect(host.testSessions().has(fileB)).toBe(true);
      expect(host.testSessions().size).toBe(2);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("C10 retention: tabs are views, not runtimes", () => {
  it("closing/reopening tabs never creates a runtime, and the owner survives", async () => {
    const a = await makeProject("tabs");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.activateExecution(a.cwd, fileA);
      const entryA = host.testSessions().get(fileA)!;
      const otherHistory = await makeSessionFile(a.cwd);

      // "Close tab" is a renderer concern: A keeps its runtime.
      expect(host.testSessions().get(fileA)).toBe(entryA);
      // Reopening B's history only reads disk.
      const createdBefore = host.testRuntimeCreationCount();
      await host.getHistory(otherHistory);
      expect(host.testRuntimeCreationCount()).toBe(createdBefore);
      expect(host.testSessions().has(otherHistory)).toBe(false);
      // Returning to live A reuses the SAME runtime — no recreation.
      expect((await host.getState(fileA)).sessionFile).toBe(fileA);
      expect(host.testSessions().get(fileA)).toBe(entryA);
      expect(host.testRuntimeCreationCount()).toBe(createdBefore);
      expect(host.testSessions().size).toBe(1);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);
});
