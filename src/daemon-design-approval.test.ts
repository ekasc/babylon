import { afterEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { parseEnvelope, serializeEnvelope, createEnvelope, type ProtocolMessageType, type ProtocolPayload } from "./daemon-protocol";
import { encodeFrame } from "./daemon-transport";
import { startDaemonServer, type DaemonServer } from "./daemon-server";
import { PiHost } from "../electron/pi-host";
import { createDesignState, loadDesignState, saveDesignState } from "../electron/design-mode/store";

/**
 * Design artifact approval over the real daemon RPC boundary.
 *
 * The host here is a REAL PiHost, not a fake: the revision comparison, the
 * state write and the follow-up dispatch are all the production code, and the
 * only thing simulated is the socket. That is the point — daemon mode is where
 * a parity bug would silently accept a stale approval.
 */

const servers: DaemonServer[] = [];
const hosts: PiHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const host of hosts.splice(0)) await host.dispose();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-daemon-design-${tag}-`));
  const agentDir = await mkdtemp(join(tmpdir(), `pideck-daemon-design-agent-${tag}-`));
  roots.push(cwd, agentDir);
  return { cwd, agentDir };
}

async function makeSessionFile(cwd: string): Promise<string> {
  const sm = SessionManager.create(cwd);
  const file = sm.getSessionFile();
  if (!file) throw new Error("no canonical session file");
  // An assistant message is required before the session is flushed to disk.
  const at = Date.now();
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "seed" }], timestamp: at });
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "seeded" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: at + 1,
  });
  return file;
}

/** A live host with one installed execution owner and a brief on disk. */
async function makeDesignHost(tag: string, brief: string) {
  const { cwd, agentDir } = await makeProject(tag);
  const host = new PiHost({
    cwd,
    agentDir,
    stateDir: join(agentDir, "pideck-state"),
    onEvent: () => undefined,
  });
  hosts.push(host);
  await host.start();

  const file = await makeSessionFile(cwd);
  const owner = await host.activateExecution(cwd, file);

  const state = createDesignState("Sessions UI", "sessions-ui");
  await mkdir(join(cwd, ".babylon", "design"), { recursive: true });
  await writeFile(join(cwd, state.briefPath), brief, "utf-8");
  await writeFile(join(cwd, state.directionPath), "# Design direction\n", "utf-8");
  await saveDesignState(cwd, owner.sessionId, state);
  return { host, cwd, sessionFile: file, sessionId: owner.sessionId, state };
}

async function serve(host: PiHost, tag: string) {
  const dir = await mkdtemp(join(tmpdir(), `pideck-daemon-design-snap-${tag}-`));
  roots.push(dir);
  const server = await startDaemonServer({
    listen: { port: 0 },
    snapshotPath: join(dir, "state.json"),
    piHost: host as unknown as Parameters<typeof startDaemonServer>[0]["piHost"],
  });
  servers.push(server);
  return server;
}

function openSocket(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => resolve(socket));
  });
}

function framed(socket: net.Socket, type: ProtocolMessageType, payload: ProtocolPayload) {
  socket.write(encodeFrame(serializeEnvelope(createEnvelope("request", type, payload))));
}

/** Await the response for a request: the server echoes the request type, and
 *  reports failures as `error`. */
function nextOutcome(socket: net.Socket, type: ProtocolMessageType, timeoutMs = 5000) {
  return new Promise<{ ok: boolean; payload: unknown }>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for a response")), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const envelope = parseEnvelope(line);
        if (envelope.type !== type && envelope.type !== "error") continue;
        clearTimeout(timer);
        socket.off("data", onData);
        resolve({ ok: envelope.type === type, payload: envelope.payload });
        return;
      }
    };
    socket.on("data", onData);
  });
}

async function call(socket: net.Socket, type: ProtocolMessageType, payload: ProtocolPayload) {
  const outcome = nextOutcome(socket, type);
  framed(socket, type, payload);
  return outcome;
}

describe("daemon design artifact approval is revision-bound", () => {
  it("refuses a stale revision, changes nothing, and does not continue", async () => {
    const { host, cwd, sessionFile, sessionId } = await makeDesignHost("stale", "# Brief\n- original goal\n");
    const server = await serve(host, "stale");
    const socket = await openSocket((server.address() as { port: number }).port);

    // 1. The user opens the review surface and reads revision A.
    const readA = await call(socket, "pi.designGetArtifact", { sessionFile, kind: "brief" });
    expect(readA.ok).toBe(true);
    const revisionA = (readA.payload as { revision: string }).revision;
    expect(revisionA).toMatch(/^[0-9a-f]{64}$/);

    // 2. The agent rewrites the brief while the surface is open.
    const state = await loadDesignState(cwd, sessionId);
    await writeFile(join(cwd, state!.briefPath), "# Brief\n- rewritten by the agent\n", "utf-8");

    // 3. The user approves what they read.
    const followUps: string[] = [];
    const entry = host.testSessions().get(sessionFile)!;
    vi.spyOn(entry.runtime.session, "sendUserMessage").mockImplementation(async (message) => {
      followUps.push(typeof message === "string" ? message : JSON.stringify(message));
    });

    const approve = await call(socket, "pi.designApproveArtifact", {
      sessionFile,
      kind: "brief",
      revision: revisionA,
    });

    // 4. Rejected, with a message the UI can act on.
    expect(approve.ok).toBe(false);
    expect(String((approve.payload as { error?: string }).error)).toMatch(/changed since you opened it/);

    // 5. Nothing was approved, and the flow did not continue underneath.
    expect((await loadDesignState(cwd, sessionId))?.briefApproved).toBe(false);
    expect(followUps).toEqual([]);
  });

  it("approves an unchanged revision and continues on the owning session", async () => {
    const { host, cwd, sessionFile, sessionId } = await makeDesignHost("happy", "# Brief\n- goal\n");
    const server = await serve(host, "happy");
    const socket = await openSocket((server.address() as { port: number }).port);

    const read = await call(socket, "pi.designGetArtifact", { sessionFile, kind: "brief" });
    const revision = (read.payload as { revision: string }).revision;

    const followUps: string[] = [];
    const entry = host.testSessions().get(sessionFile)!;
    const send = vi
      .spyOn(entry.runtime.session, "sendUserMessage")
      .mockImplementation(async (message) => {
        followUps.push(typeof message === "string" ? message : JSON.stringify(message));
      });

    const approve = await call(socket, "pi.designApproveArtifact", {
      sessionFile,
      kind: "brief",
      revision,
    });

    expect(approve.ok).toBe(true);
    const payload = approve.payload as { design: { briefApproved: boolean }; stage: string };
    expect(payload.design.briefApproved).toBe(true);
    // Brief approved, direction not yet: the stage advanced by exactly one.
    expect(payload.stage).toBe("direction");
    expect((await loadDesignState(cwd, sessionId))?.briefApproved).toBe(true);
    // The next stage starts on the OWNING session, as a follow-up turn.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ deliverAs: "followUp" });
    expect(followUps.join("\n")).toMatch(/direction stage/i);
  });

  it("rejects a malformed approval request at the boundary", async () => {
    const { host, sessionFile } = await makeDesignHost("malformed", "# Brief\n");
    const server = await serve(host, "malformed");
    const socket = await openSocket((server.address() as { port: number }).port);

    const missingRevision = await call(socket, "pi.designApproveArtifact", { sessionFile, kind: "brief" });
    expect(missingRevision.ok).toBe(false);
    expect(String((missingRevision.payload as { error?: string }).error)).toMatch(
      /requires \{ sessionFile, kind, revision \}/
    );

    const badKind = await call(socket, "pi.designApproveArtifact", {
      sessionFile,
      kind: "whatever",
      revision: "abc",
    });
    expect(badKind.ok).toBe(false);
  });
});
