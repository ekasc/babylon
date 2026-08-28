// Babylon daemon server for Phase 6 (Control Plane, Feature 13 + 14).
//
// A real, long-lived process that owns runtime authority outside the desktop
// app: it hosts the RuntimeState plus background-execution state (schedule,
// history, policy), serves typed protocol requests over newline-framed JSON on
// a TCP port or unix socket, broadcasts events to connected clients, persists
// its state atomically, and enforces the background policy on a timer so
// scheduled work keeps running when no GUI is attached.
//
// Request handling stays thin: task/attention/ping requests are delegated to
// the pure dispatch core in daemon-host.ts; state.get, policy.updated, and the
// policy tick live here because they touch server-owned state.

import * as net from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  createEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type ProtocolEnvelope,
} from "./daemon-protocol";
import { createFrameDecoder, encodeFrame, type FrameDecoder } from "./daemon-transport";
import { dispatchRequest } from "./daemon-host";
import {
  restoreRuntime,
  snapshotRuntime,
  createRuntime,
  type RuntimeState,
} from "./runtime";
import {
  createScheduledTaskRegistry,
  registerScheduledTask,
  removeScheduledTask,
  type ScheduledTask,
  type ScheduledTaskRegistry,
} from "./automation";
import {
  createAutomationHistory,
  type AutomationHistory,
  type RunnerResult,
} from "./automation-runner";
import type { PiHost } from "../electron/pi-host";
import {
  defaultPolicy,
  type BackgroundPolicy,
  type EnvironmentSignals,
} from "./background-policy";
import { runBackgroundTick } from "./background-controller";

const SNAPSHOT_VERSION = 1;

export interface DaemonState {
  runtime: RuntimeState;
  schedule: ScheduledTaskRegistry;
  history: AutomationHistory;
  policy: BackgroundPolicy;
  lastTick?: { at: number; ran: number; blocked: { taskId: string; reasons: string[] }[] };
}

export type DaemonListenOptions =
  | { socketPath: string }
  | { port: number; host?: string };

export interface DaemonServerOptions {
  listen: DaemonListenOptions;
  /** Atomic JSON persistence target. Omit to run without persistence. */
  snapshotPath?: string;
  /** Background policy tick interval. 0 disables the loop. Default 30s. */
  policyTickMs?: number;
  envSignals?: () => EnvironmentSignals;
  runAutomation?: (task: ScheduledTask) => RunnerResult;
  defaultProject?: string;
  log?: (message: string) => void;
  piHost?: PiHost;
}

export interface DaemonServer {
  address(): { port: number; host?: string } | { socketPath: string };
  /** Current server-owned state. Treat as read-only. */
  state(): DaemonState;
  /** Run one background-policy tick now (also runs automatically on the timer). */
  tick(now?: number): Promise<void>;
  /** Flush pending persistence, stop the loop, disconnect clients, close. */
  close(): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fill a valid partial policy over the defaults; reject malformed input. */
export function validatePolicyUpdate(payload: unknown): BackgroundPolicy | string {
  if (!isPlainObject(payload)) return "policy.updated requires a policy object";
  const base = defaultPolicy();
  const mode = payload.mode ?? base.mode;
  if (mode !== "never" && mode !== "while_plugged_in" && mode !== "always") {
    return `unknown background mode ${String(mode)}`;
  }
  const bool = (v: unknown, fallback: boolean): boolean | string => {
    if (v === undefined) return fallback;
    if (typeof v !== "boolean") return `expected boolean, got ${String(v)}`;
    return v;
  };
  const num = (v: unknown, fallback: number): number | string => {
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return `expected non-negative finite number, got ${String(v)}`;
    }
    return v;
  };
  const pauseOnBattery = bool(payload.pauseOnBattery, base.pauseOnBattery);
  if (typeof pauseOnBattery === "string") return pauseOnBattery;
  const pauseOnSleep = bool(payload.pauseOnSleep, base.pauseOnSleep);
  if (typeof pauseOnSleep === "string") return pauseOnSleep;
  const resumeAfterWake = bool(payload.resumeAfterWake, base.resumeAfterWake);
  if (typeof resumeAfterWake === "string") return resumeAfterWake;
  const maxConcurrentAgents = num(payload.maxConcurrentAgents, base.maxConcurrentAgents);
  if (typeof maxConcurrentAgents === "string") return maxConcurrentAgents;
  const maxBackgroundCost = num(payload.maxBackgroundCost, base.maxBackgroundCost);
  if (typeof maxBackgroundCost === "string") return maxBackgroundCost;
  let perProjectPermission = base.perProjectPermission;
  if (payload.perProjectPermission !== undefined) {
    if (!isPlainObject(payload.perProjectPermission)) {
      return "perProjectPermission must be an object of project -> boolean";
    }
    perProjectPermission = {};
    for (const [project, allowed] of Object.entries(payload.perProjectPermission)) {
      if (typeof allowed !== "boolean") {
        return `perProjectPermission.${project} must be a boolean`;
      }
      perProjectPermission[project] = allowed;
    }
  }
  return {
    mode,
    pauseOnBattery,
    pauseOnSleep,
    resumeAfterWake,
    maxConcurrentAgents,
    maxBackgroundCost,
    perProjectPermission,
  };
}

const TRIGGER_KINDS = ["interval", "daily", "file_watch", "branch_watch"] as const;

/**
 * Validate an automation task arriving over the protocol. Malformed tasks are
 * rejected here so they cannot be persisted into snapshots or broadcast to
 * clients as if they were real schedules.
 */
export function validateScheduledTask(payload: unknown): ScheduledTask | string {
  if (!isPlainObject(payload)) return "automation.registered requires a task object";
  if (typeof payload.id !== "string" || payload.id.trim().length === 0) {
    return "automation.registered requires a non-empty string id";
  }
  if (typeof payload.name !== "string") return "automation.registered requires a string name";
  if (typeof payload.enabled !== "boolean") return "automation.registered requires a boolean enabled";
  if (typeof payload.runCount !== "number" || !Number.isFinite(payload.runCount)) {
    return "automation.registered requires a finite number runCount";
  }
  const trigger = payload.trigger;
  if (!isPlainObject(trigger)) return "automation.registered requires a trigger object";
  if (!TRIGGER_KINDS.includes(trigger.kind as (typeof TRIGGER_KINDS)[number])) {
    return `automation.registered requires trigger.kind to be one of ${TRIGGER_KINDS.join(", ")}`;
  }
  return payload as unknown as ScheduledTask;
}

function emptyState(): DaemonState {
  return {
    runtime: createRuntime(),
    schedule: createScheduledTaskRegistry(),
    history: createAutomationHistory(),
    policy: defaultPolicy(),
  };
}

export async function startDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
  const log = options.log ?? (() => {});
  let state = await loadState(options.snapshotPath, log);

  // Serialize snapshot writes so concurrent mutations cannot interleave.
  let persistChain: Promise<void> = Promise.resolve();
  const persist = (): void => {
    if (!options.snapshotPath) return;
    const json = JSON.stringify({ version: SNAPSHOT_VERSION, ...serializeState(state) });
    persistChain = persistChain
      .then(() => writeAtomically(options.snapshotPath!, json))
      .catch((err) => log(`snapshot write failed: ${err instanceof Error ? err.message : String(err)}`));
  };

  const clients = new Set<net.Socket>();
  const decoders = new WeakMap<net.Socket, FrameDecoder>();

  const send = (socket: net.Socket, envelope: ProtocolEnvelope): void => {
    if (socket.destroyed) return;
    socket.write(encodeFrame(serializeEnvelope(envelope)));
  };
  const broadcast = (type: ProtocolEnvelope["type"], payload: unknown, except?: net.Socket): void => {
    const event = createEnvelope("event", type, payload);
    for (const client of clients) {
      if (client !== except) send(client, event);
    }
  };

  const handleFrame = (socket: net.Socket, json: string): void => {
    let request: ProtocolEnvelope;
    try {
      request = parseEnvelope(json);
    } catch (err) {
      send(socket, createEnvelope("response", "error", { error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    if (request.type === "state.get") {
      send(
        socket,
        createEnvelope("response", "state.snapshot", { version: SNAPSHOT_VERSION, ...serializeState(state) }, request.id)
      );
      return;
    }

    if (request.type === "policy.updated") {
      const result = validatePolicyUpdate(request.payload);
      if (typeof result === "string") {
        send(socket, createEnvelope("response", "error", { error: result }, request.id));
        return;
      }
      state = { ...state, policy: result };
      persist();
      send(socket, createEnvelope("response", "policy.updated", result, request.id));
      broadcast("policy.updated", result, socket);
      return;
    }

    if (request.type === "automation.registered") {
      const task = validateScheduledTask(request.payload);
      if (typeof task === "string") {
        send(socket, createEnvelope("response", "error", { error: task }, request.id));
        return;
      }
      const after = registerScheduledTask(state.schedule, task);
      if (after === state.schedule) {
        send(socket, createEnvelope("response", "error", { error: `scheduled task ${task.id} already exists` }, request.id));
        return;
      }
      state = { ...state, schedule: after };
      persist();
      send(socket, createEnvelope("response", "automation.registered", task, request.id));
      broadcast("automation.registered", task, socket);
      return;
    }

    if (request.type === "automation.removed") {
      const { id } = (request.payload ?? {}) as { id?: string };
      if (!id) {
        send(socket, createEnvelope("response", "error", { error: "automation.removed requires { id }" }, request.id));
        return;
      }
      const after = removeScheduledTask(state.schedule, id);
      const removed = after !== state.schedule;
      state = { ...state, schedule: after };
      if (removed) persist();
      send(socket, createEnvelope("response", "automation.removed", { id, ok: true, removed }, request.id));
      return;
    }

    // PiHost-owned session/agent lifecycle (when daemon owns PiHost). Keep this
    // before the pure dispatch so pi.* never falls through as "unsupported".
    if (request.type.startsWith("pi.")) {
      const piHost = options.piHost;
      if (!piHost) {
        send(socket, createEnvelope("response", "error", { error: "PiHost not available in daemon" }, request.id));
        return;
      }
      void (async () => {
        try {
          let payload: unknown = {};
          switch (request.type) {
            case "pi.getState":
              payload = await piHost.getState();
              break;
            case "pi.getMessages":
              payload = await piHost.getMessages();
              break;
            case "pi.getStats":
              payload = await piHost.getStats();
              break;
            case "pi.openSession": {
              const { path, cwd, requestId } = request.payload as { path?: string; cwd: string; requestId?: number };
              payload = await piHost.open({ path, cwd, requestId });
              break;
            }
            case "pi.prompt": {
              const { message, images, streamingBehavior } = request.payload as { message: string; images?: unknown[]; streamingBehavior?: string };
              payload = await piHost.prompt(message, images as never, streamingBehavior as never);
              break;
            }
            case "pi.abort":
              payload = await piHost.abort();
              break;
            case "pi.ui.respond": {
              const { id, resp } = request.payload as { id: string; resp: unknown };
              piHost.respondUi(id, resp as never);
              payload = { ok: true };
              break;
            }
            default:
              send(socket, createEnvelope("response", "error", { error: `unsupported pi request ${request.type}` }, request.id));
              return;
          }
          send(socket, createEnvelope("response", request.type, payload as never, request.id));
        } catch (err) {
          send(socket, createEnvelope("response", "error", { error: err instanceof Error ? err.message : String(err) }, request.id));
        }
      })();
      return;
    }

    // Everything else goes through the pure dispatch core (ping, task.*,
    // attention.*). Unsupported types come back as explicit errors.
    const before = state.runtime;
    const result = dispatchRequest(before, request);
    state = { ...state, runtime: result.runtime };
    send(socket, result.response);
    if (result.runtime !== before && result.response.type !== "error") {
      persist();
      broadcast(result.response.type, result.response.payload, socket);
    }
  };

  const wireClient = (socket: net.Socket): void => {
    clients.add(socket);
    const decoder = createFrameDecoder();
    decoders.set(socket, decoder);
    socket.on("data", (chunk: Buffer) => {
      const d = decoders.get(socket);
      if (!d) return;
      let frames: string[];
      try {
        frames = d.push(chunk);
      } catch (err) {
        send(socket, createEnvelope("response", "error", {
          error: err instanceof Error ? err.message : String(err),
        }));
        socket.destroy();
        return;
      }
      for (const frame of frames) handleFrame(socket, frame);
    });
    const drop = (): void => {
      clients.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  };

  const server = net.createServer(wireClient);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if ("socketPath" in options.listen) {
      const socketPath = options.listen.socketPath;
      // Refuse to start when another daemon is alive on this path. Unlinking
      // a live socket would orphan the running daemon and let two processes
      // write the same snapshot with divergent in-memory state.
      void new Promise<boolean>((probeResolve) => {
        const probe = net.connect(socketPath);
        probe.once("connect", () => {
          probe.destroy();
          probeResolve(true);
        });
        probe.once("error", () => probeResolve(false));
      }).then((alive) => {
        if (alive) {
          reject(new Error(`another daemon is already listening on ${socketPath}`));
          return;
        }
        // Stale file from a daemon that exited without cleanup; bind would
        // fail with EADDRINUSE until it is removed.
        try {
          unlinkSync(socketPath);
        } catch {
          // No stale socket, nothing to clean.
        }
        mkdirSync(dirname(socketPath), { recursive: true });
        server.listen(socketPath, resolve);
      });
    } else {
      server.listen(options.listen.port, options.listen.host ?? "127.0.0.1", resolve);
    }
  });
  if ("socketPath" in options.listen) {
    // The protocol has no authentication; restrict the socket to the owner
    // so only the same user can drive the daemon.
    try {
      chmodSync(options.listen.socketPath, 0o600);
    } catch {
      // Platforms without posix permissions.
    }
  }

  const tick = async (now = Date.now()): Promise<void> => {
    const out = runBackgroundTick({
      schedule: state.schedule,
      history: state.history,
      attention: state.runtime.attention,
      contracts: state.runtime.contracts,
      policy: state.policy,
      defaultProject: options.defaultProject ?? "",
      env: options.envSignals
        ? options.envSignals()
        : { onBattery: false, asleep: false, activeAgents: 0, currentCost: 0 },
      now,
      run:
        options.runAutomation ??
        (() => ({ success: false, error: "no automation executor configured" })),
    });
    const changed =
      out.schedule !== state.schedule ||
      out.history !== state.history ||
      out.attention !== state.runtime.attention;
    state = {
      ...state,
      runtime: { ...state.runtime, attention: out.attention },
      schedule: out.schedule,
      history: out.history,
      lastTick: { at: now, ran: out.ran.length, blocked: out.blocked },
    };
    for (const run of out.ran) broadcast("automation.ran", run);
    if (changed) persist();
  };

  const policyTickMs = options.policyTickMs ?? 30_000;
  let timer: NodeJS.Timeout | null = null;
  if (policyTickMs > 0) {
    if (options.runAutomation) {
      // The catch keeps an unexpected tick error from becoming an unhandled
      // rejection that could take the daemon down.
      timer = setInterval(() => {
        tick().catch((err) => log(`background tick failed: ${err instanceof Error ? err.message : String(err)}`));
      }, policyTickMs);
      timer.unref();
    } else {
      log("background policy loop disabled: no automation executor configured");
    }
  }

  return {
    address() {
      const addr = server.address();
      if (typeof addr === "object" && addr && "port" in addr) {
        return { port: addr.port, host: addr.address };
      }
      return { socketPath: (options.listen as { socketPath?: string }).socketPath ?? "" };
    },
    state() {
      return state;
    },
    tick,
    close() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const client of clients) client.destroy();
      clients.clear();
      return persistChain.then(
        () => new Promise<void>((resolve) => server.close(() => resolve()))
      );
    },
  };
}

function serializeState(state: DaemonState) {
  return {
    runtime: JSON.parse(snapshotRuntime(state.runtime)),
    schedule: state.schedule,
    history: state.history,
    policy: state.policy,
    lastTick: state.lastTick,
  };
}

async function writeAtomically(path: string, json: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Random suffix so concurrent writers from different processes can never
  // target the same temp file.
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, json, "utf8");
  await rename(tmp, path);
}

async function loadState(path: string | undefined, log: (m: string) => void): Promise<DaemonState> {
  const fresh = emptyState();
  if (!path) return fresh;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return fresh; // Missing file is a normal first run.
  }
  try {
    const parsed = JSON.parse(raw) as { version?: number; runtime?: unknown } & Partial<DaemonState>;
    if (parsed.version !== SNAPSHOT_VERSION) throw new Error(`unsupported snapshot version ${String(parsed.version)}`);
    const runtime = parsed.runtime !== undefined ? restoreRuntime(JSON.stringify(parsed.runtime)) : fresh.runtime;
    return {
      runtime,
      schedule: isPlainObject(parsed.schedule) && isPlainObject(parsed.schedule.tasks)
        ? (parsed.schedule as ScheduledTaskRegistry)
        : fresh.schedule,
      history: isPlainObject(parsed.history) && Array.isArray(parsed.history.runs)
        ? (parsed.history as AutomationHistory)
        : fresh.history,
      policy: normalizeOrFresh(parsed.policy, fresh.policy),
      lastTick: undefined,
    };
  } catch (err) {
    log(`ignoring corrupt daemon snapshot: ${err instanceof Error ? err.message : String(err)}`);
    return fresh;
  }
}

function normalizeOrFresh(raw: unknown, fresh: BackgroundPolicy): BackgroundPolicy {
  const normalized = validatePolicyUpdate(raw);
  return typeof normalized === "string" ? fresh : normalized;
}
