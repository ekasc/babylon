import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { utimesSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost, defaultStateDir, type HostOptions, type SessionEntry } from "./pi-host";
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
      // Unknown model fails before touching anything: A keeps its state.
      await expect(host.setModel("nope", "missing")).rejects.toThrow(/Model not found/);
      const stateB = await host.getState();
      expect(stateB.sessionFile).toBe(fileB);
      // Idle aborts resolve without affecting the other runtime.
      await host.abort(fileA);
      await host.abort(fileB);
      const sessions = host.testSessions();
      expect(sessions.size).toBe(2);
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

  it("releases idle runtimes and refuses live ones", async () => {
    const a = await makeProject("e");
    const { host } = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const fileA = await makeSessionFile(a.cwd);
      await host.open({ path: fileA, cwd: a.cwd });
      expect(await host.releaseSession(fileA)).toBe(true);
      expect(host.testSessions().size).toBe(0);
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

      // Gate the thread scan inside releaseSession(A) so reactivation lands
      // mid-scan: without post-await revalidation the gated release would
      // dispose A out from under the fresh foreground.
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      let gated = false;
      const scan = vi
        .spyOn(host as unknown as { hasActiveThreadsForSession: (id: string) => Promise<boolean> }, "hasActiveThreadsForSession")
        .mockImplementation(async () => {
          if (!gated) {
            gated = true;
            await gate;
          }
          return false;
        });
      try {
        const releasing = host.releaseSession(fileA);
        await vi.waitFor(() => expect(gated).toBe(true));
        await host.ensureForeground(fileA);
        expect(host.activeSessionFile).toBe(fileA);
        releaseGate();
        // Reactivation touched lastUsedAt and the foreground pointer during
        // the scan: the release must refuse, never dispose a live session.
        expect(await releasing).toBe(false);
        expect(host.testSessions().has(fileA)).toBe(true);
        expect(host.activeSessionFile).toBe(fileA);
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

      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      let gated = false;
      const scan = vi
        .spyOn(host as unknown as { hasActiveThreadsForSession: (id: string) => Promise<boolean> }, "hasActiveThreadsForSession")
        .mockImplementation(async () => {
          if (!gated) {
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
        const releasing = host.releaseSession(fileB);
        await vi.waitFor(() => expect(gated).toBe(true));
        // resolveEntry touches lastUsedAt synchronously at prompt start —
        // before isStreaming flips — so the gated release must still abort.
        await host.prompt("hello B", undefined, undefined, fileB);
        releaseGate();
        expect(await releasing).toBe(false);
        expect(delivered).toEqual([`${fileB}:hello B`]);
        expect(host.testSessions().has(fileB)).toBe(true);
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
      // First reactivation seeds the fingerprint from the existing file.
      await host.open({ path: fileA, cwd: a.cwd });
      expect(host.activeSessionFile).toBe(fileA);
      openSpy.mockClear();
      // A → B → A with no disk change: the retained runtime is current, so
      // activation must not reopen/reparse the transcript.
      await host.open({ path: fileB, cwd: b.cwd });
      await host.open({ path: fileA, cwd: a.cwd });
      expect(host.activeSessionFile).toBe(fileA);
      expect(openSpy).not.toHaveBeenCalled();
      // A real change (mtime bump) re-arms the sync on the next activation.
      await host.open({ path: fileB, cwd: b.cwd });
      openSpy.mockClear();
      const future = new Date(Date.now() + 30_000);
      await utimes(fileA, future, future);
      await host.open({ path: fileA, cwd: a.cwd });
      expect(host.activeSessionFile).toBe(fileA);
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
      // Seed the fingerprint, then force a sync during which a second
      // append lands mid-read (mtime bump inside SessionManager.open).
      // The stored fingerprint must be the pre-read one, so the raced
      // append mismatches on the following activation and re-syncs —
      // never goes invisible.
      await host.open({ path: fileA, cwd: a.cwd });
      await utimes(fileA, new Date(Date.now() + 30_000), new Date(Date.now() + 30_000));
      const raced = new Date(Date.now() + 60_000);
      openSpy.mockImplementationOnce((...args: Parameters<typeof SessionManager.open>) => {
        utimesSync(fileA, raced, raced);
        return origOpen(...args);
      });
      await host.open({ path: fileB, cwd: b.cwd });
      await host.open({ path: fileA, cwd: a.cwd });
      openSpy.mockClear();
      await host.open({ path: fileB, cwd: b.cwd });
      await host.open({ path: fileA, cwd: a.cwd });
      expect(host.activeSessionFile).toBe(fileA);
      expect(openSpy).toHaveBeenCalled();
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
      // ensureForeground/newSession carry no requestId, so a stale ready
      // from A would be accepted by the renderer — it must never be sent.
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
        const slowA = host.ensureForeground(fileA);
        // Let A's activation reach the gated restore before B starts.
        await vi.waitFor(() => expect(gated).toBe(true));
        await host.ensureForeground(fileB);
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

  it("evicts oldest idle runtimes past the cap, never the foreground", async () => {
    const { cwd, agentDir } = await makeProject("evict");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    try {
      const files: string[] = [];
      for (let i = 0; i < 11; i++) {
        const file = await makeSessionFile(cwd);
        files.push(file);
        await host.open({ path: file, cwd });
      }
      // 11 opens, foreground is the last: 10 idle, cap is 8.
      await host.evictIdleSessions();
      const sessions = host.testSessions();
      expect(sessions.size).toBe(9); // 8 idle + foreground
      expect(sessions.has(files[files.length - 1]!)).toBe(true);
      // Oldest idle runtimes evicted first.
      expect(sessions.has(files[0]!)).toBe(false);
      expect(sessions.has(files[1]!)).toBe(false);
    } finally {
      await host.dispose();
    }
  }, 120_000);

  it("eviction walks past thread-live candidates to reach idle ones", async () => {
    const { cwd, agentDir } = await makeProject("evict-threads");
    const { host } = makeHost(cwd, agentDir);
    await host.start();
    try {
      // Nine opens: 8 idle + foreground, no overflow, so nothing evicts yet.
      const files: string[] = [];
      for (let i = 0; i < 9; i++) {
        const file = await makeSessionFile(cwd);
        files.push(file);
        await host.open({ path: file, cwd });
      }
      // Pin live threads onto the two OLDEST sessions: releaseSession must
      // refuse them, and the sweep must skip over them to evict idle ones
      // behind them instead of stopping. Directory names use the loop index:
      // session ids share a time-based prefix, so an id-derived name would
      // collide and the second pin would overwrite the first.
      const toPin = files.slice(0, 2);
      for (const [i, file] of toPin.entries()) {
        const sessionId = host.testSessions().get(file!)!.sessionId;
        const dir = join(cwd, ".pi", "state", "threads", `thread-pinned-${i}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "thread.json"), JSON.stringify({
          threadId: `thread-pinned-${i}`, status: "running", parentSessionId: sessionId,
        }));
      }
      // Two more opens force overflow; the per-open sweeps and the explicit
      // one below all see the blocked oldest pair.
      for (let i = 0; i < 2; i++) {
        const file = await makeSessionFile(cwd);
        files.push(file);
        await host.open({ path: file, cwd });
      }
      // Serializes behind any in-flight per-open sweep: deterministic.
      await host.evictIdleSessions();
      const after = host.testSessions();
      expect(after.size).toBe(9); // 8 idle + foreground
      expect(after.has(files[files.length - 1]!)).toBe(true);
      // Thread-live oldest survive…
      expect(after.has(files[0]!)).toBe(true);
      expect(after.has(files[1]!)).toBe(true);
      // …so the two next-oldest idle runtimes go instead.
      expect(after.has(files[2]!)).toBe(false);
      expect(after.has(files[3]!)).toBe(false);
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
        const start = await host.testCaptureTurnStart();
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
    await expect(host.prompt("hi")).rejects.toThrow(/draining/);
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
