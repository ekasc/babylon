import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { parseEnvelope, serializeEnvelope, createEnvelope } from "./daemon-protocol";
import { encodeFrame } from "./daemon-transport";
import { startRemoteServer, type RemoteServer, type RemoteServerOptions } from "./remote-server";
import { createDeviceRegistry, pairDevice, type DeviceRegistry } from "./device-pairing";
import { hashToken } from "./remote-auth";

const servers: RemoteServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function pair(registry: DeviceRegistry, id: string, scope: Parameters<typeof pairDevice>[1]["scope"], token: string) {
  const next = pairDevice(registry, { id, name: id, scope, tokenHash: hashToken(token), now: 1 });
  if (typeof next === "string") throw new Error(next);
  return next;
}

async function start(opts: { registry: RemoteServerOptions["registry"] } & Partial<Omit<RemoteServerOptions, "registry" | "listen">>) {
  const server = await startRemoteServer({ listen: { port: 0 }, ...opts });
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

describe("babylon remote server", () => {
  it("rejects actions before authentication and with a bad token", async () => {
    const registry = pair(
      createDeviceRegistry(),
      "d1",
      ["view_tasks"],
      "tok"
    );
    const server = await start({ registry });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);

    await request(socket, "remote.tasks.list", {});
    await expect(r.next("error")).resolves.toMatchObject({
      payload: { error: "authenticate with remote.auth first" },
    });

    await request(socket, "remote.auth", { deviceId: "d1", token: "wrong" });
    await expect(r.next("error")).resolves.toMatchObject({ payload: { error: "authentication failed" } });

    await request(socket, "remote.auth", { deviceId: "ghost", token: "tok" });
    await expect(r.next("error")).resolves.toMatchObject({ payload: { error: "authentication failed" } });

    // Correct token unlocks the session.
    await request(socket, "remote.auth", { deviceId: "d1", token: "tok" });
    await expect(r.next("remote.auth")).resolves.toMatchObject({ kind: "response", payload: { ok: true } });
  });

  it("enforces scopes per action", async () => {
    const registry = pair(createDeviceRegistry(), "viewer", ["view_tasks"], "tok");
    const server = await start({ registry, view: { listTasks: () => [] } });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);

    await request(socket, "remote.auth", { deviceId: "viewer", token: "tok" });
    await r.next("remote.auth");

    await request(socket, "remote.tasks.list", {});
    await expect(r.next("remote.tasks.list")).resolves.toMatchObject({
      kind: "response",
      payload: { tasks: [] },
    });

    await request(socket, "remote.diffs.view", {});
    const denied = await r.next("error");
    expect(denied.payload).toMatchObject({ error: expect.stringContaining("view_diffs") });
  });

  it("serves reads from the injected view and mutations through handlers", async () => {
    const registry = pair(createDeviceRegistry(), "boss", [
      "view_tasks",
      "view_state",
      "approve_deny",
      "answer_questions",
      "stop_resume",
      "view_diffs",
    ], "tok");
    const calls: string[] = [];
    const server = await start({
      registry,
      view: {
        listTasks: () => [{ id: "t1", title: "Refactor auth", state: "running" }],
        viewState: () => ({ agent: "Main Agent", status: "awaiting_approval" }),
        viewDiffs: () => [{ file: "src/a.ts", additions: 12 }],
      },
      handlers: {
        resolveAttention: (id) => calls.push(`attention:${id}`),
        answerQuestion: (id, answer) => calls.push(`question:${id}:${answer}`),
        stopResumeTask: (id, action) => calls.push(`task:${id}:${action}`),
      },
    });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "remote.auth", { deviceId: "boss", token: "tok" });
    await r.next("remote.auth");

    await request(socket, "remote.tasks.list", {});
    await expect(r.next("remote.tasks.list")).resolves.toMatchObject({
      payload: { tasks: [{ id: "t1" }] },
    });

    await request(socket, "remote.state.view", {});
    await expect(r.next("remote.state.view")).resolves.toMatchObject({
      payload: { state: { agent: "Main Agent" } },
    });

    await request(socket, "remote.diffs.view", {});
    await expect(r.next("remote.diffs.view")).resolves.toMatchObject({
      payload: { diffs: [{ file: "src/a.ts" }] },
    });

    await request(socket, "remote.attention.resolve", { id: "a1" });
    await r.next("remote.attention.resolve");
    await request(socket, "remote.question.answer", { id: "q1", answer: "yes" });
    await r.next("remote.question.answer");
    await request(socket, "remote.task.stop_resume", { id: "t1", action: "pause" });
    await r.next("remote.task.stop_resume");
    expect(calls).toEqual(["attention:a1", "question:q1:yes", "task:t1:pause"]);
  });

  it("denies a device revoked mid-session on its next action", async () => {
    let reg = pair(createDeviceRegistry(), "d1", ["view_tasks"], "tok");
    const server = await start({
      registry: () => reg,
      onRegistryChange: (next) => {
        reg = next;
      },
    });
    const port = (server.address() as { port: number }).port;
    const socket = await connect(port);
    const r = reader(socket);
    await request(socket, "remote.auth", { deviceId: "d1", token: "tok" });
    await r.next("remote.auth");

    const { revokeDevice } = await import("./device-pairing");
    reg = revokeDevice(reg, "d1");

    await request(socket, "remote.tasks.list", {});
    await expect(r.next("error")).resolves.toMatchObject({
      payload: { error: expect.stringContaining("revoked") },
    });
  });

  it("pushes attention only to devices holding receive_attention", async () => {
    const registry = pair(pair(
      createDeviceRegistry(),
      "watcher",
      ["receive_attention"],
      "w-tok"
    ), "viewer", ["view_tasks"], "v-tok");
    const server = await start({ registry });
    const port = (server.address() as { port: number }).port;

    const watcher = await connect(port);
    const rw = reader(watcher);
    await request(watcher, "remote.auth", { deviceId: "watcher", token: "w-tok" });
    await rw.next("remote.auth");

    const viewer = await connect(port);
    const rv = reader(viewer);
    await request(viewer, "remote.auth", { deviceId: "viewer", token: "v-tok" });
    await rv.next("remote.auth");

    server.pushAttention({ id: "a9", title: "Permission required: git push" });

    await expect(rw.next("attention.raised")).resolves.toMatchObject({
      kind: "event",
      payload: { id: "a9" },
    });
    // The viewer has no receive_attention scope; a short window must stay silent.
    await expect(rv.next("attention.raised", 150)).rejects.toThrow(/timed out/);
  });
});
