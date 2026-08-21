// Babylon remote server for Phase 7 (Remote Control, Feature 15).
//
// A small, deliberately narrow surface for trusted devices: after token
// authentication, a device may call only the remote.* actions its grant
// allows, and it receives attention pushes only if it holds the
// receive_attention scope. This is not the desktop workspace over the wire;
// it is view state, approvals, answers, and transport controls.
//
// The server never mutates domain state itself. Mutating actions are handed
// to caller-supplied callbacks so the daemon/desktop stays the single source
// of truth.

import * as net from "node:net";
import {
  createEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type ProtocolEnvelope,
} from "./daemon-protocol";
import { createFrameDecoder, encodeFrame } from "./daemon-transport";
import { touchDevice, type DeviceRegistry } from "./device-pairing";
import { verifyToken } from "./remote-auth";
import { authorizeAction, REMOTE_ACTION_KINDS, type RemoteActionKind } from "./remote-actions";

export interface RemoteServerOptions {
  listen: { socketPath: string } | { port: number; host?: string };
  /**
   * Device grants. Pass a getter when the caller replaces the registry
   * immutably (pairing, revocation); the server always reads the latest.
   */
  registry: DeviceRegistry | (() => DeviceRegistry);
  /** Receives registry updates the server makes itself (lastSeen touches). */
  onRegistryChange?: (next: DeviceRegistry) => void;
  now?: () => number;
  log?: (message: string) => void;
  /** Read-only views backing the remote read actions. */
  view?: {
    listTasks?: () => unknown;
    viewState?: () => unknown;
    viewDiffs?: () => unknown;
  };
  /** Mutations the device may request; absent means unsupported. */
  handlers?: {
    resolveAttention?: (id: string) => void;
    answerQuestion?: (id: string, answer: string) => void;
    stopResumeTask?: (id: string, action: "stop" | "pause" | "resume") => void;
  };
}

export interface RemoteServer {
  address(): { port: number; host?: string } | { socketPath: string };
  /**
   * Push an attention item to every authenticated device holding the
   * receive_attention scope.
   */
  pushAttention(item: Record<string, unknown>): void;
  close(): Promise<void>;
}

interface RemoteSession {
  deviceId: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startRemoteServer(options: RemoteServerOptions): Promise<RemoteServer> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const currentRegistry = (): DeviceRegistry =>
    typeof options.registry === "function" ? options.registry() : options.registry;

  const sessions = new Map<net.Socket, RemoteSession>();

  const send = (socket: net.Socket, envelope: ProtocolEnvelope): void => {
    if (socket.destroyed) return;
    socket.write(encodeFrame(serializeEnvelope(envelope)));
  };

  const handleFrame = (socket: net.Socket, json: string): void => {
    let request: ProtocolEnvelope;
    try {
      request = parseEnvelope(json);
    } catch (err) {
      send(socket, createEnvelope("response", "error", { error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    const session = sessions.get(socket) ?? { deviceId: null };

    if (request.type === "remote.auth") {
      const payload = request.payload as { deviceId?: unknown; token?: unknown };
      const deviceId = typeof payload?.deviceId === "string" ? payload.deviceId : "";
      const token = typeof payload?.token === "string" ? payload.token : "";
      const device = currentRegistry().devices[deviceId];
      if (!device || device.revoked || !device.tokenHash || !verifyToken(token, device.tokenHash)) {
        // One generic reason: do not tell an unauthenticated peer which part failed.
        send(socket, createEnvelope("response", "error", { error: "authentication failed" }, request.id));
        return;
      }
      session.deviceId = deviceId;
      sessions.set(socket, session);
      const touched = touchDevice(currentRegistry(), deviceId, now());
      if (touched !== currentRegistry()) {
        options.onRegistryChange?.(touched);
      }
      send(socket, createEnvelope("response", "remote.auth", { deviceId, ok: true }, request.id));
      return;
    }

    if (!REMOTE_ACTION_KINDS.includes(request.type as RemoteActionKind)) {
      send(socket, createEnvelope("response", "error", { error: `unsupported request type ${request.type}` }, request.id));
      return;
    }

    if (!session.deviceId) {
      send(socket, createEnvelope("response", "error", { error: "authenticate with remote.auth first" }, request.id));
      return;
    }

    const action = request.type as RemoteActionKind;
    const allowed = authorizeAction(currentRegistry(), session.deviceId, action);
    if (!allowed.ok) {
      send(socket, createEnvelope("response", "error", { error: allowed.reason }, request.id));
      return;
    }

    const payload = isPlainObject(request.payload) ? request.payload : {};
    switch (action) {
      case "remote.tasks.list": {
        if (!options.view?.listTasks) {
          send(socket, createEnvelope("response", "error", { error: "tasks are not available" }, request.id));
          return;
        }
        send(socket, createEnvelope("response", action, { tasks: options.view.listTasks() }, request.id));
        return;
      }
      case "remote.state.view": {
        if (!options.view?.viewState) {
          send(socket, createEnvelope("response", "error", { error: "agent state is not available" }, request.id));
          return;
        }
        send(socket, createEnvelope("response", action, { state: options.view.viewState() }, request.id));
        return;
      }
      case "remote.diffs.view": {
        if (!options.view?.viewDiffs) {
          send(socket, createEnvelope("response", "error", { error: "diffs are not available" }, request.id));
          return;
        }
        send(socket, createEnvelope("response", action, { diffs: options.view.viewDiffs() }, request.id));
        return;
      }
      case "remote.attention.resolve": {
        const id = typeof payload.id === "string" ? payload.id : "";
        if (!id) {
          send(socket, createEnvelope("response", "error", { error: "requires { id }" }, request.id));
          return;
        }
        if (!options.handlers?.resolveAttention) {
          send(socket, createEnvelope("response", "error", { error: "resolving attention is not supported" }, request.id));
          return;
        }
        options.handlers.resolveAttention(id);
        send(socket, createEnvelope("response", action, { id, ok: true }, request.id));
        return;
      }
      case "remote.question.answer": {
        const id = typeof payload.id === "string" ? payload.id : "";
        const answer = typeof payload.answer === "string" ? payload.answer : "";
        if (!id || !answer.trim()) {
          send(socket, createEnvelope("response", "error", { error: "requires { id, answer }" }, request.id));
          return;
        }
        if (!options.handlers?.answerQuestion) {
          send(socket, createEnvelope("response", "error", { error: "answering questions is not supported" }, request.id));
          return;
        }
        options.handlers.answerQuestion(id, answer);
        send(socket, createEnvelope("response", action, { id, ok: true }, request.id));
        return;
      }
      case "remote.task.stop_resume": {
        const id = typeof payload.id === "string" ? payload.id : "";
        const act = payload.action;
        if (!id || (act !== "stop" && act !== "pause" && act !== "resume")) {
          send(socket, createEnvelope("response", "error", { error: "requires { id, action: stop | pause | resume }" }, request.id));
          return;
        }
        if (!options.handlers?.stopResumeTask) {
          send(socket, createEnvelope("response", "error", { error: "task control is not supported" }, request.id));
          return;
        }
        options.handlers.stopResumeTask(id, act);
        send(socket, createEnvelope("response", action, { id, action: act, ok: true }, request.id));
        return;
      }
    }
  };

  const wireClient = (socket: net.Socket): void => {
    const decoder = createFrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      let frames: string[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        send(socket, createEnvelope("response", "error", { error: err instanceof Error ? err.message : String(err) }));
        socket.destroy();
        return;
      }
      for (const frame of frames) handleFrame(socket, frame);
    });
    const drop = (): void => {
      sessions.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  };

  const server = net.createServer(wireClient);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if ("socketPath" in options.listen) {
      server.listen(options.listen.socketPath, resolve);
    } else {
      server.listen(options.listen.port, options.listen.host ?? "127.0.0.1", resolve);
    }
  });

  return {
    address() {
      const addr = server.address();
      if (typeof addr === "object" && addr && "port" in addr) {
        return { port: addr.port, host: addr.address };
      }
      return { socketPath: (options.listen as { socketPath?: string }).socketPath ?? "" };
    },
    pushAttention(item) {
      const event = createEnvelope("event", "attention.raised", item);
      for (const [socket, session] of sessions) {
        if (!session.deviceId) continue;
        const device = currentRegistry().devices[session.deviceId];
        if (!device || device.revoked || !device.scope.includes("receive_attention")) continue;
        send(socket, event);
      }
    },
    close() {
      for (const socket of sessions.keys()) socket.destroy();
      sessions.clear();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
