// Babylon daemon client for Phase 6 (Feature 13).
//
// The desktop (or any future client) talks to the daemon through this typed
// client: correlated request/response calls, an event subscription, and
// automatic reconnection with capped backoff. Reconnection is what makes
// "reopen Babylon and reconnect to existing tasks" work: when the socket
// drops, in-flight requests fail loudly, and new requests queue until the
// daemon answers again.

import * as net from "node:net";
import {
  createEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type ProtocolEnvelope,
  type ProtocolMessageType,
} from "./daemon-protocol";
import { createFrameDecoder, encodeFrame } from "./daemon-transport";

export class DaemonRequestError extends Error {
  /** The error envelope from the daemon, when the failure was a typed one. */
  public readonly envelope?: ProtocolEnvelope;

  constructor(message: string, envelope?: ProtocolEnvelope) {
    super(message);
    this.envelope = envelope;
  }
}

export interface DaemonClientOptions {
  listen: { socketPath: string } | { port: number; host?: string };
  /** false disables reconnection. Defaults to capped exponential backoff. */
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number } | false;
  requestTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface DaemonClient {
  request(type: ProtocolMessageType, payload: unknown, timeoutMs?: number): Promise<ProtocolEnvelope>;
  onEvent(handler: (envelope: ProtocolEnvelope) => void): () => void;
  connected(): boolean;
  close(): void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5_000;

interface PendingCall {
  resolve: (envelope: ProtocolEnvelope) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export function connectDaemonClient(options: DaemonClientOptions): DaemonClient {
  const log = options.log ?? (() => {});
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reconnectEnabled = options.reconnect !== false;
  const initialDelayMs = (options.reconnect && options.reconnect.initialDelayMs) || DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = (options.reconnect && options.reconnect.maxDelayMs) || DEFAULT_MAX_DELAY_MS;

  let socket: net.Socket | null = null; // current connection attempt
  let live: net.Socket | null = null; // connected and writable
  let closed = false;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const pending = new Map<string, PendingCall>();
  const connectionWaiters: { resolve: (s: net.Socket) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }[] = [];
  const eventHandlers = new Set<(envelope: ProtocolEnvelope) => void>();

  const failPending = (message: string): void => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new DaemonRequestError(message));
    }
    pending.clear();
    for (const waiter of connectionWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new DaemonRequestError(message));
    }
  };

  const scheduleReconnect = (): void => {
    if (!reconnectEnabled || closed || reconnectTimer) return;
    const base = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt));
    const delay = base / 2 + Math.random() * (base / 2);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
    reconnectTimer.unref();
  };

  const handleEnvelope = (envelope: ProtocolEnvelope): void => {
    if (envelope.kind === "response" && envelope.inReplyTo) {
      const call = pending.get(envelope.inReplyTo);
      if (call) {
        pending.delete(envelope.inReplyTo);
        clearTimeout(call.timer);
        if (envelope.type === "error") {
          const message =
            typeof (envelope.payload as { error?: unknown })?.error === "string"
              ? (envelope.payload as { error: string }).error
              : "daemon request failed";
          call.reject(new DaemonRequestError(message, envelope));
        } else {
          call.resolve(envelope);
        }
      }
      return;
    }
    if (envelope.kind === "event") {
      for (const handler of eventHandlers) handler(envelope);
    }
  };

  const open = (): void => {
    if (closed || socket) return;
    const next =
      "socketPath" in options.listen
        ? net.connect(options.listen.socketPath)
        : net.connect(options.listen.port, options.listen.host ?? "127.0.0.1");
    socket = next;
    const decoder = createFrameDecoder();

    next.on("connect", () => {
      attempt = 0;
      live = next;
      for (const waiter of connectionWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(next);
      }
    });
    next.on("data", (chunk: Buffer) => {
      let frames: string[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        log(`frame decode failed: ${err instanceof Error ? err.message : String(err)}`);
        next.destroy();
        return;
      }
      for (const frame of frames) {
        try {
          handleEnvelope(parseEnvelope(frame));
        } catch (err) {
          log(`bad envelope from daemon: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
    const drop = (): void => {
      // Only the socket that was live (or the current attempt) may touch
      // shared state; a late failure from an older attempt must not kill
      // requests being served by the current connection.
      const wasLive = live === next;
      const wasCurrent = socket === next;
      if (wasLive) live = null;
      if (wasCurrent) socket = null;
      if (!wasLive && !wasCurrent) return;

      // In-flight calls fail loudly. Requests waiting for a (re)connection
      // stay queued while reconnection continues; they die only when the
      // client closes or reconnection is disabled.
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new DaemonRequestError("daemon connection lost"));
      }
      pending.clear();
      if (!reconnectEnabled || closed) {
        for (const waiter of connectionWaiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new DaemonRequestError("daemon connection lost"));
        }
        return;
      }
      scheduleReconnect();
    };
    next.on("close", drop);
    next.on("error", () => {
      // close always follows; keep the handler so Node does not throw.
    });
  };

  open();

  const waitForConnection = (timeoutMs: number): Promise<net.Socket> => {
    if (live) return Promise.resolve(live);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = connectionWaiters.findIndex((w) => w.timer === timer);
        if (i !== -1) connectionWaiters.splice(i, 1);
        reject(new DaemonRequestError(`timed out waiting for daemon connection after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      connectionWaiters.push({ resolve, reject, timer });
    });
  };

  return {
    async request(type, payload, timeoutMs = requestTimeoutMs): Promise<ProtocolEnvelope> {
      if (closed) throw new DaemonRequestError("client is closed");
      const conn = await waitForConnection(timeoutMs);
      // The connection can drop while this call waited its turn; writing to
      // the dead socket would hang until timeout instead of failing now.
      if (live !== conn) throw new DaemonRequestError("daemon connection lost");
      const envelope = createEnvelope("request", type, payload);
      return await new Promise<ProtocolEnvelope>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(envelope.id);
          reject(new DaemonRequestError(`request ${type} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
        pending.set(envelope.id, { resolve, reject, timer });
        conn.write(encodeFrame(serializeEnvelope(envelope)));
      });
    },

    onEvent(handler): () => void {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },

    connected(): boolean {
      return live !== null;
    },

    close(): void {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      failPending("client is closed");
      if (live) {
        live.destroy();
        live = null;
      }
      if (socket) {
        socket.destroy();
        socket = null;
      }
    },
  };
}
