import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvelope, serializeEnvelope, createEnvelope, DAEMON_PROTOCOL_VERSION, type ProtocolMessageType, type ProtocolPayload } from "./daemon-protocol";
import { encodeFrame } from "./daemon-transport";
import { hashToken } from "./remote-auth";
import { startDaemonServer, type DaemonPiHost, type DaemonServer } from "./daemon-server";
import type { ScheduledTask } from "./automation";
import { createTask } from "./tasks";
import { PermissionEngine } from "../electron/permissions";
import { HookManager } from "../electron/hook-manager";
import type { HookDefinition } from "./hooks";

const servers: DaemonServer[] = [];
const tempDirs: string[] = [];

async function start(opts: Partial<Parameters<typeof startDaemonServer>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "babylon-daemon-"));
  tempDirs.push(dir);
  const server = await startDaemonServer({
    listen: { port: 0 },
    snapshotPath: join(dir, "state.json"),
    ...opts,
  });
  servers.push(server);
  return server;
}

/** Partial PiHost fake: unmentioned methods throw if the server calls them. */
function fakePiHost(overrides: Partial<DaemonPiHost>): DaemonPiHost {
  const fail = (name: string) => () => {
    throw new Error(`not stubbed: ${name}`);
  };
  return {
    open: fail("open"),
    prompt: fail("prompt"),
    abort: fail("abort"),
    respondUi: fail("respondUi"),
    notifyDiagnostics: fail("notifyDiagnostics"),
    getToolOutput: fail("getToolOutput"),
    getModels: fail("getModels"),
    warmProject: fail("warmProject"),
    setModel: fail("setModel"),
    getThinkingLevels: fail("getThinkingLevels"),
    setThinking: fail("setThinking"),
    getSettings: fail("getSettings"),
    setSettings: fail("setSettings"),
    setSessionName: fail("setSessionName"),
    renameSession: fail("renameSession"),
    beginGoalPrompt: fail("beginGoalPrompt"),
    compact: fail("compact"),
    getTree: fail("getTree"),
    getHistory: fail("getHistory"),
    getTurnChanges: fail("getTurnChanges"),
    getTurnFileDiff: fail("getTurnFileDiff"),
    prepareRollback: fail("prepareRollback"),
    commitRollback: fail("commitRollback"),
    undoRollback: fail("undoRollback"),
    getForkMessages: fail("getForkMessages"),
    fork: fail("fork"),
    clone: fail("clone"),
    generateGitCommitMessage: fail("generateGitCommitMessage"),
    getRecaps: fail("getRecaps"),
    refreshFromDisk: fail("refreshFromDisk"),
    switchTo: fail("switchTo"),
    activeSessionFile: null,
    controlThread: fail("controlThread"),
    promoteThread: fail("promoteThread"),
    controlSubagent: fail("controlSubagent"),
    promoteSubagent: fail("promoteSubagent"),
    execGoalCommand: fail("execGoalCommand"),
    execDesignCommand: fail("execDesignCommand"),
    beginDesignPrompt: fail("beginDesignPrompt"),
    getState: fail("getState"),
    getMessages: fail("getMessages"),
    getStats: fail("getStats"),
    getCommands: fail("getCommands"),
    attachSinks: () => undefined,
    ...overrides,
  };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => resolve(socket));
  });
}

/**
 * A socket with no data listener stays in paused mode and never processes a
 * FIN, so close events never fire. Every real client consumes frames; mirror
 * that here for tests that do not read responses.
 */
function drain(socket: net.Socket): void {
  socket.on("data", () => {});
}

function connectSocketPath(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => resolve(socket));
  });
}

/** Collect frames from a socket; resolves each wait for a matching type. */
function reader(socket: net.Socket) {
  const queue: ReturnType<typeof parseEnvelope>[] = [];
  const waiters: { type: string; resolve: (e: ReturnType<typeof parseEnvelope>) => void }[] = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const envelope = parseEnvelope(line);
      const w = waiters.findIndex((x) => x.type === envelope.type);
      if (w === -1) queue.push(envelope);
      else waiters.splice(w, 1)[0]?.resolve(envelope);
    }
  });
  return {
    next(type: string, timeoutMs = 2000): Promise<ReturnType<typeof parseEnvelope>> {
      const queued = queue.findIndex((e) => e.type === type);
      const found = queued !== -1 ? queue.splice(queued, 1)[0] : undefined;
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
        waiters.push({
          type,
          resolve: (e) => {
            clearTimeout(t);
            resolve(e);
          },
        });
      });
    },
  };
}

async function request(socket: net.Socket, type: ProtocolMessageType, payload: ProtocolPayload) {
  socket.write(encodeFrame(serializeEnvelope(createEnvelope("request", type, payload))));
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  tempDirs.length = 0;
});

describe("babylon daemon server", () => {
  it("answers ping and serves a state snapshot", async () => {
    const server = await start();
    const addr = server.address() as { port: number };
    const socket = await connect(addr.port);
    const r = reader(socket);
    await request(socket, "ping", {});
    await expect(r.next("pong")).resolves.toMatchObject({ kind: "response" });

    await request(socket, "state.get", {});
    const snap = await r.next("state.snapshot");
    expect(snap.payload).toMatchObject({ version: 1, runtime: { version: 1 } });
  });

  it("advertises its protocol version on pong so a mismatched client can retire it", async () => {
    const server = await start();
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "ping", { protocol: DAEMON_PROTOCOL_VERSION });
    const res = await r.next("pong");
    expect((res.payload as { protocol?: unknown }).protocol).toBe(DAEMON_PROTOCOL_VERSION);
  });

  it("acks daemon.shutdown before running the shutdown hook", async () => {
    let stopped = false;
    const server = await start({ onShutdown: () => { stopped = true; } });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "daemon.shutdown", {});
    const res = await r.next("daemon.shutdown");
    expect(res.payload).toEqual({ ok: true });
    // The ack is sent before the hook so the caller is not left hanging.
    expect(stopped).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(stopped).toBe(true);
  });

  it("serves pi.goalControl by running the invocation and wrapping the fresh goal", async () => {
    const goal = {
      active: true,
      paused: false,
      objective: "Ship it",
      slug: "ship-it",
      status: "executing" as const,
      currentStep: "step",
      startedAt: new Date(0).toISOString(),
      acceptanceCriteria: [],
      nonGoals: [],
      completedSteps: [],
      evidence: [],
      log: [],
    };
    const seen: Array<[string, string]> = [];
    const piHost = fakePiHost({
      execGoalCommand: async (sessionFile: string, args: string) => {
        seen.push([sessionFile, args]);
        return goal;
      },
    });
    const server = await start({ piHost });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "pi.goalControl", { sessionFile: "/s/a.jsonl", args: "pause" });
    const res = await r.next("pi.goalControl");
    expect(res.payload).toEqual({ goal });
    expect(seen).toEqual([["/s/a.jsonl", "pause"]]);
    await request(socket, "pi.goalControl", { args: 42 });
    const err = await r.next("error");
    expect(String((err.payload as { error?: string }).error)).toMatch(/requires \{ sessionFile, args \}/);
  });

  it("serves pi.goalBeginPrompt with the full turn payload", async () => {
    const goal = {
      active: true,
      paused: false,
      objective: "Fix it",
      slug: "fix-it",
      status: "planning" as const,
      currentStep: "step",
      startedAt: new Date(0).toISOString(),
      acceptanceCriteria: [],
      nonGoals: [],
      completedSteps: [],
      evidence: [],
      log: [],
    };
    const seen: Array<[string, string, string]> = [];
    const piHost = fakePiHost({
      beginGoalPrompt: async (sessionFile: string, objective: string, message: string) => {
        seen.push([sessionFile, objective, message]);
        return { goal, started: true, error: null };
      },
    });
    const server = await start({ piHost });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "pi.goalBeginPrompt", { sessionFile: "/s/a.jsonl", objective: "Fix it", message: "Fix it" });
    const res = await r.next("pi.goalBeginPrompt");
    expect(res.payload).toEqual({ goal, started: true, error: null });
    expect(seen).toEqual([["/s/a.jsonl", "Fix it", "Fix it"]]);
    await request(socket, "pi.goalBeginPrompt", { sessionFile: "/s/a.jsonl" });
    const err = await r.next("error");
    expect(String((err.payload as { error?: string }).error)).toMatch(/requires \{ sessionFile, objective, message \}/);
  });

  it("wraps pi.getCommands in { commands } for the thin client", async () => {
    const piHost = fakePiHost({
      getCommands: async () => [{ name: "ls", description: "list", source: "prompt" as const }],
    });
    const server = await start({ piHost });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "pi.getCommands", {});
    const res = await r.next("pi.getCommands");
    expect(res.payload).toEqual({ commands: [{ name: "ls", description: "list", source: "prompt" }] });
  });

  it("serves pi.designControl addressed to a session", async () => {
    const status = { design: null, stage: "idle" as const };
    const seen: Array<[string, string]> = [];
    const piHost = fakePiHost({
      execDesignCommand: async (sessionFile: string, args: string) => {
        seen.push([sessionFile, args]);
        return status;
      },
    });
    const server = await start({ piHost });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "pi.designControl", { sessionFile: "/s/a.jsonl", args: "approve-brief" });
    const res = await r.next("pi.designControl");
    expect(res.payload).toEqual(status);
    expect(seen).toEqual([["/s/a.jsonl", "approve-brief"]]);
    await request(socket, "pi.designControl", { args: "approve-brief" });
    const err = await r.next("error");
    expect(String((err.payload as { error?: string }).error)).toMatch(/requires \{ sessionFile, args \}/);
  });

  it("serves pi.designBeginPrompt with the full turn payload", async () => {
    const outcome = { design: null, stage: "elicit" as const, started: true, error: null };
    const seen: Array<[string, string, string]> = [];
    const piHost = fakePiHost({
      beginDesignPrompt: async (sessionFile: string, subject: string, message: string) => {
        seen.push([sessionFile, subject, message]);
        return outcome;
      },
    });
    const server = await start({ piHost });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "pi.designBeginPrompt", { sessionFile: "/s/a.jsonl", subject: "Redesign", message: "Redesign" });
    const res = await r.next("pi.designBeginPrompt");
    expect(res.payload).toEqual(outcome);
    expect(seen).toEqual([["/s/a.jsonl", "Redesign", "Redesign"]]);
    await request(socket, "pi.designBeginPrompt", { sessionFile: "/s/a.jsonl" });
    const err = await r.next("error");
    expect(String((err.payload as { error?: string }).error)).toMatch(/requires \{ sessionFile, subject, message \}/);
  });

  it("wraps array results so the protocol envelope stays an object", async () => {
    const piHost = fakePiHost({
      getMessages: async () => [{ role: "user", content: "hi" }],
      getModels: async () => [{ provider: "pi", id: "m1" }],
      getThinkingLevels: async () => ["low", "high"],
      getForkMessages: async () => [{ entryId: "e1" }],
      getRecaps: async () => [{ id: "r1", at: "2026-01-01T00:00:00.000Z", coveredEntryId: null, text: "Recap: r1" }],
    });
    const server = await start({ piHost });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);

    await request(socket, "pi.getMessages", {});
    expect((await r.next("pi.getMessages")).payload).toEqual({ messages: [{ role: "user", content: "hi" }] });

    await request(socket, "pi.getModels", {});
    expect((await r.next("pi.getModels")).payload).toEqual({ models: [{ provider: "pi", id: "m1" }] });

    await request(socket, "pi.getThinkingLevels", {});
    expect((await r.next("pi.getThinkingLevels")).payload).toEqual({ levels: ["low", "high"] });

    await request(socket, "pi.getForkMessages", {});
    expect((await r.next("pi.getForkMessages")).payload).toEqual({ messages: [{ entryId: "e1" }] });

    await request(socket, "pi.getRecaps", { sessionFile: "/tmp/s.jsonl" });
    expect((await r.next("pi.getRecaps")).payload).toEqual({ recaps: [{ id: "r1", at: "2026-01-01T00:00:00.000Z", coveredEntryId: null, text: "Recap: r1" }] });
  });

  it("serves pi.warmProject by delegating to the host", async () => {
    const warmed: string[] = [];
    const piHost = fakePiHost({
      warmProject: (cwd: string) => {
        warmed.push(cwd);
        return { warmed: true };
      },
    });
    const server = await start({ piHost });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "pi.warmProject", { cwd: "/tmp/project" });
    const res = await r.next("pi.warmProject");
    expect(res.payload).toEqual({ warmed: true });
    expect(warmed).toEqual(["/tmp/project"]);
  });

  it("answers an oversized response with a typed error instead of dropping the connection", async () => {
    const piHost = fakePiHost({
      getMessages: async () => [{ role: "assistant", content: "x".repeat(8192) }],
    });
    const server = await start({ piHost, maxFrameBytes: 1024 });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "pi.getMessages", {});
    const res = await r.next("error");
    expect(String((res.payload as { error?: string }).error)).toMatch(/exceeds the transport frame limit/);
    // The socket survives: a dropped connection is what made the client
    // reconnect and retry the same oversized request forever.
    await request(socket, "ping", {});
    await expect(r.next("pong")).resolves.toMatchObject({ kind: "response" });
  });

  it("applies task requests, persists them, and broadcasts events to other clients", async () => {
    const server = await start();
    const port = (server.address() as { port: number }).port;
    const a = await connect(port);
    const b = await connect(port);
    const ra = reader(a);
    const rb = reader(b);

    await request(a, "task.created", createTask({ id: "t1", title: "from a" }));
    await expect(ra.next("task.created")).resolves.toMatchObject({ kind: "response" });
    // b receives the same change as an event, not a response.
    await expect(rb.next("task.created")).resolves.toMatchObject({ kind: "event" });

    // A fresh server on the same snapshot path sees the persisted task.
    const dir = tempDirs[0];
    if (!dir) throw new Error("missing temp dir");
    await server.close();
    const revived = await startDaemonServer({
      listen: { port: 0 },
      snapshotPath: join(dir, "state.json"),
    });
    servers.push(revived);
    expect(revived.state().runtime.tasks.tasks.t1?.title).toBe("from a");
  });

  it("rejects malformed policy updates without changing state", async () => {
    const server = await start();
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "policy.updated", { mode: "sometimes" });
    await expect(r.next("error")).resolves.toMatchObject({ kind: "response" });
    expect(server.state().policy.mode).toBe("while_plugged_in");

    await request(socket, "policy.updated", { mode: "always", maxConcurrentAgents: 2 });
    const ok = await r.next("policy.updated");
    expect(ok.kind).toBe("response");
    expect(server.state().policy).toMatchObject({ mode: "always", maxConcurrentAgents: 2 });
  });

  it("runs due automation on tick, records history, raises attention on failure, and broadcasts runs", async () => {
    let calls = 0;
    const task: ScheduledTask = {
      id: "s1",
      name: "deps",
      enabled: true,
      trigger: { kind: "interval", intervalMs: 1 },
      project: "/proj",
      runCount: 0,
    };
    const server = await start({
      policyTickMs: 0, // manual ticks only
      runAutomation: () => {
        calls += 1;
        return calls === 1 ? { success: true } : { success: false, error: "boom" };
      },
    });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);

    await request(socket, "automation.registered", task);
    const registered = await r.next("automation.registered");
    expect(registered.kind).toBe("response");

    await server.tick(1000);
    const runEvent = await r.next("automation.ran");
    expect(runEvent.kind).toBe("event");
    expect(runEvent.payload).toMatchObject({ taskId: "s1", status: "succeeded" });

    await server.tick(2000);
    const failed = await r.next("automation.ran");
    expect(failed.payload).toMatchObject({ taskId: "s1", status: "failed", error: "boom" });
    expect(server.state().runtime.attention.items[`automation-${(failed.payload as { id: string }).id}`]).toBeDefined();
    expect(server.state().history.runs).toHaveLength(2);
    expect(server.state().lastTick).toMatchObject({ ran: 1 });
  });

  it("destroys a client that sends an oversized frame", async () => {
    const server = await start({ maxFrameBytes: 1024 });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    drain(socket);
    // Craft the oversized frame on the wire directly: the decoder must reject
    // it and drop the client.
    const big = JSON.stringify({
      id: "m1",
      kind: "request",
      type: "ping",
      payload: { padding: "x".repeat(1024 * 1024 + 10) },
      ts: Date.now(),
    });
    socket.write(big + "\n");
    await new Promise<void>((resolve) => socket.once("close", resolve));
    expect(socket.destroyed).toBe(true);
  });

  it("refuses to start a second daemon on a live socket path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-daemon-"));
    const socketPath = join(dir, "live.sock");
    const first = await startDaemonServer({ listen: { socketPath }, policyTickMs: 0 });
    servers.push(first);
    await expect(startDaemonServer({ listen: { socketPath }, policyTickMs: 0 })).rejects.toThrow(
      /already listening/
    );
    // The first daemon still answers after the refused start.
    const socket = await connectSocketPath(socketPath);
    drain(socket);
    socket.write(encodeFrame(serializeEnvelope(createEnvelope("request", "ping", {}))));
    socket.end();
    await new Promise<void>((resolve) => socket.once("close", resolve));
  });

  it("rejects malformed automation.registered payloads", async () => {
    const server = await start();
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    for (const bad of [
      { id: "s9" }, // missing name/enabled/runCount/trigger
      { id: "s9", name: "x", enabled: true, runCount: 0, trigger: { kind: "hourly" } },
      { id: "s9", name: "x", enabled: "yes", runCount: 0, trigger: { kind: "interval" } },
      { id: "", name: "x", enabled: true, runCount: 0, trigger: { kind: "interval" } },
    ]) {
      await request(socket, "automation.registered", bad);
      await expect(r.next("error")).resolves.toMatchObject({ kind: "response" });
    }
    expect(Object.keys(server.state().schedule.tasks)).toHaveLength(0);
  });

  it("persists contracts across restart so the completion gate survives", async () => {
    const server = await start();
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);

    const contract = {
      id: "c1",
      title: "Ship it",
      checks: [{ kind: "tests", label: "tests pass", required: true }],
    };
    await request(socket, "contract.registered", contract);
    await expect(r.next("contract.registered")).resolves.toMatchObject({ kind: "response" });
    const task = { ...createTask({ id: "t1", title: "x" }), contractId: "c1" };
    await request(socket, "task.created", task);
    await r.next("task.created");

    // A fresh daemon on the same snapshot must still know the contract.
    const dir = tempDirs[0];
    if (!dir) throw new Error("missing temp dir");
    await server.close();
    const revived = await startDaemonServer({
      listen: { port: 0 },
      snapshotPath: join(dir, "state.json"),
    });
    servers.push(revived);
    expect(revived.state().runtime.contracts.c1?.title).toBe("Ship it");
    expect(revived.state().runtime.tasks.tasks.t1?.contractId).toBe("c1");

    // The gate still blocks on the revived daemon and raises failed_task.
    const revivedPort = (revived.address() as { port: number }).port;
    const revivedSocket = await connect(revivedPort);
    const rr = reader(revivedSocket);
    await request(revivedSocket, "task.complete", { id: "t1", results: [{ kind: "tests", passed: false }] });
    const completion = await rr.next("task.complete");
    expect(completion.kind).toBe("response");
    expect(completion.payload).toMatchObject({ blocked: true, reason: "contract failed: tests pass" });
    expect(revived.state().runtime.tasks.tasks.t1?.status).not.toBe("completed");
    const item = Object.values(revived.state().runtime.attention.items)[0];
    expect(item).toMatchObject({ type: "failed_task", title: "Completion blocked: Ship it" });
  });

  it("replays persisted hooks into the live HookManager on restart", async () => {
    const hook: HookDefinition = {
      id: "h-1",
      event: "pre_tool_use",
      action: "block",
      enabled: true,
    };
    // Round 1: register a hook and shut the daemon down. The registry is
    // persisted via the existing hooks.register path.
    const dir = await mkdtemp(join(tmpdir(), "babylon-daemon-hooks-"));
    tempDirs.push(dir);
    const snapshot = join(dir, "state.json");
    const liveHookManager = new HookManager();
    const first = await startDaemonServer({
      listen: { port: 0 },
      snapshotPath: snapshot,
      hookManager: liveHookManager,
    });
    servers.push(first);
    const firstPort = (first.address() as { port: number }).port;
    const firstSocket = await connect(firstPort);
    const fr = reader(firstSocket);
    await request(firstSocket, "hooks.register", hook);
    await expect(fr.next("hooks.register")).resolves.toMatchObject({ kind: "response" });
    expect(liveHookManager.list().map((h) => h.id)).toEqual(["h-1"]);

    await first.close();
    // After close, the live manager still has the hook from registration,
    // so simulate a process restart by constructing a brand-new manager.
    const restartedHookManager = new HookManager();
    expect(restartedHookManager.list()).toEqual([]);

    // Round 2: a fresh daemon on the same snapshot must rehydrate the
    // persisted hook into the live manager, otherwise PiHost's
    // pre_tool_use / post_tool_use dispatch would silently no-op while the
    // UI claims the hook exists.
    const revived = await startDaemonServer({
      listen: { port: 0 },
      snapshotPath: snapshot,
      hookManager: restartedHookManager,
    });
    servers.push(revived);
    expect(restartedHookManager.list().map((h) => h.id)).toEqual(["h-1"]);
  });

  it("broadcasts attention.raised when a task.complete blocks on its contract", async () => {
    const server = await start();
    const port = (server.address() as { port: number }).port;
    const a = await connect(port);
    const b = await connect(port);
    const ra = reader(a);
    const rb = reader(b);

    await request(a, "contract.registered", {
      id: "c1",
      title: "Ship it",
      checks: [{ kind: "typecheck", label: "typecheck clean", required: true }],
    });
    await ra.next("contract.registered");
    await request(a, "task.created", { ...createTask({ id: "t1", title: "x" }), contractId: "c1" });
    await ra.next("task.created");
    await rb.next("task.created"); // b sees the task as an event

    await request(a, "task.complete", { id: "t1", results: [{ kind: "typecheck", passed: false }] });
    await expect(ra.next("task.complete")).resolves.toMatchObject({ kind: "response" });
    // b sees the blocked completion and the raised attention item.
    const blockEvent = await rb.next("task.complete");
    expect(blockEvent.kind).toBe("event");
    expect(blockEvent.payload).toMatchObject({ blocked: true });
    const raised = await rb.next("attention.raised");
    expect(raised.kind).toBe("event");
    expect(raised.payload).toMatchObject({ type: "failed_task", title: "Completion blocked: Ship it" });
  });

  it("returns an error response for unsupported request types", async () => {
    const server = await start();
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "session.created", {});
    await expect(r.next("error")).resolves.toMatchObject({ kind: "response" });
  });

  it("serves and mutates the daemon permission engine over the protocol", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-perm-"));
    tempDirs.push(dir);
    const engine = new PermissionEngine({ dir });
    await engine.load();
    const server = await start({ permissionEngine: engine });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);

    await request(socket, "permissions.get", {});
    await expect(r.next("permissions.get")).resolves.toMatchObject({ payload: { mode: "auto", rules: [] } });

    await request(socket, "permissions.set-mode", { mode: "full_access" });
    await expect(r.next("permissions.set-mode")).resolves.toMatchObject({ kind: "response" });
    await expect(r.next("permissions.changed")).resolves.toMatchObject({ kind: "event", payload: { mode: "full_access" } });

    await request(socket, "permissions.add-rule", { category: "git_push", decision: "deny", scope: "always" });
    await expect(r.next("permissions.add-rule")).resolves.toMatchObject({ payload: { category: "git_push", decision: "deny" } });
    await expect(r.next("permissions.changed")).resolves.toMatchObject({ kind: "event" });
    expect(engine.evaluate({ category: "git_push" }).decision).toBe("deny");
  });

  it("routes approvals through the protocol and applies their rules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-perm-"));
    tempDirs.push(dir);
    const engine = new PermissionEngine({ dir });
    await engine.load();
    const server = await start({ permissionEngine: engine });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);

    // Settle the connection so the server has registered this socket before a
    // server-initiated approval broadcast (rather than a request response).
    await request(socket, "ping", {});
    await r.next("pong");

    const allowed = server.requestApproval({ category: "shell_command", command: "npm test" }, "uncertain");
    const req = await r.next("approval.requested");
    expect(req.kind).toBe("event");
    expect(req.payload).toMatchObject({ action: { category: "shell_command", command: "npm test" }, risk: "uncertain" });
    await request(socket, "approval.resolved", { id: (req.payload as { id: string }).id, choice: "allow_session" });
    await expect(r.next("approval.resolved")).resolves.toMatchObject({ kind: "response" });
    await expect(allowed).resolves.toBe(true);
    await expect(r.next("permissions.changed")).resolves.toMatchObject({ kind: "event" });
    expect(engine.evaluate({ category: "shell_command", command: "npm test" }).decision).toBe("allow");

    const denied = server.requestApproval({ category: "git_push" }, "high");
    const denyReq = await r.next("approval.requested");
    await request(socket, "approval.resolved", { id: (denyReq.payload as { id: string }).id, choice: "deny" });
    await expect(r.next("approval.resolved")).resolves.toMatchObject({ kind: "response" });
    await expect(denied).resolves.toBe(false);
    await expect(r.next("permissions.changed")).resolves.toMatchObject({ kind: "event" });
    expect(engine.evaluate({ category: "git_push" }).decision).toBe("deny");
  });

  it("TCP mode rejects unauthenticated requests, including state snapshots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-perm-"));
    tempDirs.push(dir);
    const engine = new PermissionEngine({ dir });
    await engine.load();
    const server = await start({ permissionEngine: engine, authTokenHash: hashToken("owner-secret") });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);

    await request(socket, "permissions.set-mode", { mode: "full_access" });
    await expect(r.next("error")).resolves.toMatchObject({ payload: { error: "daemon authentication required" } });
    await request(socket, "state.get", {});
    await expect(r.next("error")).resolves.toMatchObject({ payload: { error: "daemon authentication required" } });
    // Nothing mutated behind the gate.
    expect(engine.getMode()).toBe("auto");
    socket.destroy();
  });

  it("TCP mode rejects wrong tokens but accepts the owner token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-perm-"));
    tempDirs.push(dir);
    const engine = new PermissionEngine({ dir });
    await engine.load();
    const server = await start({ permissionEngine: engine, authTokenHash: hashToken("owner-secret") });
    const port = (server.address() as { port: number }).port;

    const bad = await connect(port);
    const rb = reader(bad);
    await request(bad, "daemon.auth", { token: "wrong" });
    await expect(rb.next("error")).resolves.toMatchObject({ payload: { error: "daemon authentication failed" } });
    await request(bad, "permissions.set-mode", { mode: "full_access" });
    await expect(rb.next("error")).resolves.toMatchObject({ payload: { error: "daemon authentication required" } });
    expect(engine.getMode()).toBe("auto");
    bad.destroy();

    const good = await connect(port);
    const rg = reader(good);
    await request(good, "daemon.auth", { token: "owner-secret" });
    await expect(rg.next("daemon.auth")).resolves.toMatchObject({ payload: { ok: true } });
    await request(good, "permissions.set-mode", { mode: "full_access" });
    await expect(rg.next("permissions.set-mode")).resolves.toMatchObject({ payload: { mode: "full_access" } });
    expect(engine.getMode()).toBe("full_access");
    good.destroy();
  });

  it("Unix-socket mode needs no token", async () => {    const dir = await mkdtemp(join(tmpdir(), "babylon-daemon-"));
    tempDirs.push(dir);
    const server = await startDaemonServer({
      listen: { socketPath: join(dir, "daemon.sock") },
      snapshotPath: join(dir, "state.json"),
    });
    servers.push(server);
    const socket = await connectSocketPath(join(dir, "daemon.sock"));
    const r = reader(socket);
    await request(socket, "ping", {});
    await expect(r.next("pong")).resolves.toMatchObject({ kind: "response" });
    await request(socket, "daemon.auth", { token: "anything" });
    await expect(r.next("daemon.auth")).resolves.toMatchObject({ payload: { ok: true } });
    socket.destroy();
  });

  it("approval.list exposes pending approvals for detached renderers (A06)", async () => {
    const server = await start({});
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);

    await request(socket, "ping", {});
    await r.next("pong");
    const asked = server.requestApproval({ category: "shell_command", command: "rm -rf /" }, "high", "sess-9");
    const req = await r.next("approval.requested");
    expect(req.payload).toMatchObject({ sessionId: "sess-9" });

    // A second connection (a reloaded renderer) sees the same pending item.
    const late = await connect(port);
    const rl = reader(late);
    await request(late, "approval.list", {});
    await expect(rl.next("approval.list")).resolves.toMatchObject({
      payload: {
        approvals: [
          {
            id: (req.payload as { id: string }).id,
            risk: "high",
            sessionId: "sess-9",
          },
        ],
      },
    });

    // Resolution removes it from the list.
    const id = (req.payload as { id: string }).id;
    await request(late, "approval.resolved", { id, choice: "deny" });
    await rl.next("approval.resolved");
    await expect(asked).resolves.toBe(false);
    await request(late, "approval.list", {});
    await expect(rl.next("approval.list")).resolves.toMatchObject({ payload: { approvals: [] } });
    socket.destroy();
    late.destroy();
  });

  it("invalid hook registration is a protocol error, not a crash (A07)", async () => {
    const server = await start({});
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);

    await request(socket, "hooks.register", { id: "bad", event: "pre_tool_use", enabled: true, timeoutMs: -1 });
    await expect(r.next("error")).resolves.toMatchObject({ payload: { error: expect.stringContaining("timeoutMs") } });
    await request(socket, "hooks.register", { event: "pre_tool_use", enabled: true });
    await expect(r.next("error")).resolves.toMatchObject({ payload: { error: expect.stringContaining("id") } });
    await request(socket, "hooks.remove", {});
    await expect(r.next("error")).resolves.toMatchObject({ payload: { error: expect.stringContaining("id") } });
    // Server still answers afterwards.
    await request(socket, "ping", {});
    await expect(r.next("pong")).resolves.toMatchObject({ kind: "response" });
    socket.destroy();
  });
});

describe("toSettingsPatch", () => {
  it("passes valid patches through", async () => {
    const { toSettingsPatch } = await import("./lib/settings-patch");
    expect(
      toSettingsPatch({ chatModel: { provider: "acme", modelId: "m1" }, chatReasoning: "high" })
    ).toEqual({ chatModel: { provider: "acme", modelId: "m1" }, chatReasoning: "high" });
  });

  it("drops unknown keys and rejects mistyped values", async () => {
    const { toSettingsPatch } = await import("./lib/settings-patch");
    expect(toSettingsPatch({ chatModel: { provider: "a", modelId: "b" }, evil: "x" })).toEqual({
      chatModel: { provider: "a", modelId: "b" },
    });
    expect(() => toSettingsPatch("nope")).toThrow("must be an object");
    expect(() => toSettingsPatch({ chatModel: { provider: "a" } })).toThrow("modelId");
    expect(() => toSettingsPatch({ appearance: { theme: "neon" } })).toThrow("theme");
    expect(toSettingsPatch({ appearance: { theme: "dark" } })).toEqual({ appearance: { theme: "dark" } });
    expect(() => toSettingsPatch({ contextWindowOverrides: { "a/b": "lots" } })).toThrow(
      "Record<string, number>"
    );
  });
});
