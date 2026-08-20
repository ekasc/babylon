import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvelope, serializeEnvelope, createEnvelope } from "./daemon-protocol";
import { encodeFrame } from "./daemon-transport";
import { startDaemonServer, type DaemonServer } from "./daemon-server";
import type { ScheduledTask } from "./automation";
import { createTask } from "./tasks";

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
      if (w !== -1) waiters.splice(w, 1)[0].resolve(envelope);
      else queue.push(envelope);
    }
  });
  return {
    next(type: string, timeoutMs = 2000): Promise<ReturnType<typeof parseEnvelope>> {
      const queued = queue.findIndex((e) => e.type === type);
      if (queued !== -1) return Promise.resolve(queue.splice(queued, 1)[0]);
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

async function request(socket: net.Socket, type: string, payload: unknown) {
  socket.write(encodeFrame(serializeEnvelope(createEnvelope("request", type as never, payload))));
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
    await request(socket, "ping", null);
    await expect(r.next("pong")).resolves.toMatchObject({ kind: "response" });

    await request(socket, "state.get", {});
    const snap = await r.next("state.snapshot");
    expect(snap.payload).toMatchObject({ version: 1, runtime: { version: 1 } });
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
    const server = await start();
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    drain(socket);
    const big = JSON.stringify(createEnvelope("request", "ping", null)).replace("null", `"${"x".repeat(1024 * 1024 + 10)}"`);
    socket.write(big + "\n");
    await new Promise<void>((resolve) => socket.once("close", resolve));
    expect(socket.destroyed).toBe(true);
  });

  it("returns an error response for unsupported request types", async () => {
    const server = await start();
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "session.created", {});
    await expect(r.next("error")).resolves.toMatchObject({ kind: "response" });
  });
});
