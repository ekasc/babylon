import { afterEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectDaemonClient, DaemonRequestError, type DaemonClient } from "./daemon-client";
import { startDaemonServer, type DaemonServer } from "./daemon-server";

const servers: DaemonServer[] = [];
const clients: DaemonClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

async function startSocketServer(socketPath: string) {
  const server = await startDaemonServer({ listen: { socketPath }, policyTickMs: 0 });
  servers.push(server);
  return server;
}

describe("babylon daemon client", () => {
  it("correlates request responses over TCP", async () => {
    const server = await startDaemonServer({ listen: { port: 0 }, policyTickMs: 0 });
    servers.push(server);
    const port = (server.address() as { port: number }).port;
    const client = connectDaemonClient({ listen: { port }, reconnect: false });
    clients.push(client);

    const pong = await client.request("ping", null);
    expect(pong.type).toBe("pong");
    expect(client.connected()).toBe(true);
  });

  it("delivers events to subscribers and unsubscribes", async () => {
    const server = await startDaemonServer({ listen: { port: 0 }, policyTickMs: 0 });
    servers.push(server);
    const port = (server.address() as { port: number }).port;
    const a = connectDaemonClient({ listen: { port }, reconnect: false });
    const b = connectDaemonClient({ listen: { port }, reconnect: false });
    clients.push(a, b);
    await a.request("ping", null); // wait until both are connected
    await b.request("ping", null);

    const seen: string[] = [];
    const unsubscribe = a.onEvent((e) => seen.push(e.type));
    await b.request("task.created", { id: "t1", title: "x" });

    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (seen.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 10);
      setTimeout(() => {
        clearInterval(t);
        resolve();
      }, 1000);
    });
    expect(seen).toContain("task.created");

    unsubscribe();
    await b.request("task.created", { id: "t2", title: "y" });
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).not.toContain("t2-created");
  });

  it("surfaces typed daemon errors", async () => {
    const server = await startDaemonServer({ listen: { port: 0 }, policyTickMs: 0 });
    servers.push(server);
    const port = (server.address() as { port: number }).port;
    const client = connectDaemonClient({ listen: { port }, reconnect: false });
    clients.push(client);

    await expect(client.request("task.updated", { id: "missing", patch: {} })).rejects.toThrow(/not found/);
  });

  it("rejects requests that time out", async () => {
    // A raw listener that never answers simulates an unresponsive daemon.
    // resume() keeps the connection socket out of paused mode so it can
    // process the client's FIN and server.close() can complete.
    const server = net.createServer((socket) => {
      socket.resume();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });
    const client = connectDaemonClient({ listen: { port }, reconnect: false });
    clients.push(client);
    await expect(client.request("ping", null, 100)).rejects.toThrow(/timed out/);
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fails in-flight requests on disconnect and reconnects to a restarted daemon", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-daemon-client-"));
    const socketPath = join(dir, "d.sock");
    const server = await startSocketServer(socketPath);
    const client = connectDaemonClient({
      listen: { socketPath },
      reconnect: { initialDelayMs: 20, maxDelayMs: 200 },
    });
    clients.push(client);
    await client.request("ping", null);

    // In-flight request at the moment the daemon dies must fail loudly.
    const inflight = client.request("ping", null, 5000);
    await server.close();
    await expect(inflight).rejects.toBeInstanceOf(DaemonRequestError);
    await vi.waitFor(() => expect(client.connected()).toBe(false));

    // A daemon restarts on the same socket path; the client recovers by itself.
    await startSocketServer(socketPath);
    const recovered = await client.request("state.get", {}, 5000);
    expect(recovered.type).toBe("state.snapshot");
    expect(client.connected()).toBe(true);
  });

  it("queues requests made while disconnected until the daemon returns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-daemon-client-"));
    const socketPath = join(dir, "d.sock");
    const server = await startSocketServer(socketPath);
    const client = connectDaemonClient({
      listen: { socketPath },
      reconnect: { initialDelayMs: 20, maxDelayMs: 200 },
    });
    clients.push(client);
    await client.request("ping", null);
    await server.close();
    // Wait until the client has observed the disconnect; a request issued on
    // the dying socket would fail in-flight instead of queueing.
    await vi.waitFor(() => expect(client.connected()).toBe(false));

    const queued = client.request("ping", null, 5000);
    await startSocketServer(socketPath);
    await expect(queued).resolves.toMatchObject({ type: "pong" });
  });

  it("rejects immediately when reconnection is disabled and the daemon is gone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-daemon-client-"));
    const socketPath = join(dir, "d.sock");
    const server = await startSocketServer(socketPath);
    const client = connectDaemonClient({ listen: { socketPath }, reconnect: false });
    clients.push(client);
    await client.request("ping", null);
    await server.close();
    await vi.waitFor(() => expect(client.connected()).toBe(false));
    await expect(client.request("ping", null, 500)).rejects.toThrow(/connection|timed out/);
  });

  it("reports connect and disconnect transitions via onConnectionChange", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-daemon-cb-"));
    const socketPath = join(dir, "daemon.sock");
    const server = await startSocketServer(socketPath);
    const client = connectDaemonClient({ listen: { socketPath } });
    clients.push(client);

    const states: ("connected" | "disconnected")[] = [];
    const unsub = client.onConnectionChange((s) => states.push(s));

    // The handler should have observed the already-connected state.
    await new Promise((r) => setTimeout(r, 50));
    expect(states).toContain("connected");

    // Drop the daemon to force a disconnect.
    await server.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(states).toContain("disconnected");
    unsub();
  });
});
