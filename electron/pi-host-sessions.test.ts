import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost, defaultStateDir } from "./pi-host";
import { SnapshotStore } from "./snapshot-store";

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
  const events: any[] = [];
  const statuses: any[] = [];
  const host = new PiHost({
    cwd,
    agentDir,
    stateDir: join(agentDir, "pideck-state"),
    ...(sessionsRoot ? { sessionsRoot } : {}),
    onEvent: (ev: any) => events.push(ev),
    onStatus: (s: any) => statuses.push(s),
  } as any);
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
      const sessions = (host as any).sessions as Map<string, unknown>;
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
      const sessions = (host as any).sessions as Map<string, unknown>;
      expect(sessions.size).toBe(2);
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
      expect((host as any).sessions.size).toBe(0);
      expect(await host.releaseSession("/nonexistent.json")).toBe(true);
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
      const projects = (host as any).projectRuntimes as Map<string, unknown>;
      expect([...projects.keys()].sort()).toEqual([a.cwd, b.cwd].sort());
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe("drain for restart", () => {
  function liveSession(streaming: boolean) {
    return { runtime: { session: { isStreaming: streaming, sessionId: "s1" } } };
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
    (host as any).sessions.set("f", liveSession(true));
    expect(host.activeTurnCount()).toBe(1);
    expect(await host.drainTurns(60)).toBe(false);
    await host.dispose();
  });

  it("returns true when the turn ends mid-wait", async () => {
    const { cwd, agentDir } = await makeProject("drain-finish");
    const { host } = makeHost(cwd, agentDir);
    const fake = liveSession(true);
    (host as any).sessions.set("f", fake);
    setTimeout(() => {
      fake.runtime.session.isStreaming = false;
    }, 20);
    expect(await host.drainTurns(1000)).toBe(true);
    expect(host.activeTurnCount()).toBe(0);
    await host.dispose();
  });

  it("counts approval-blocked sessions as live", async () => {
    const { cwd, agentDir } = await makeProject("drain-ui");
    const { host } = makeHost(cwd, agentDir);
    (host as any).sessions.set("f", liveSession(false));
    expect(host.activeTurnCount()).toBe(0);
    (host as any).uiRequests.set("u1", { sessionFile: "f", resolve: () => undefined, reject: () => undefined });
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
      expect((host as any).foregroundSessionFile).toBe(inside);
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
