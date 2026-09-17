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

function makeHost(cwd: string, agentDir: string) {
  const events: any[] = [];
  const statuses: any[] = [];
  const host = new PiHost({
    cwd,
    agentDir,
    stateDir: join(agentDir, "pideck-state"),
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
