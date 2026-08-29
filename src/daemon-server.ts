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
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  createEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type ProtocolEnvelope,
} from "./daemon-protocol";
import { registerHook, removeHook, type HookDefinition } from "./hooks";
import type { HookManager } from "../electron/hook-manager";
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
import { applyApproval, PermissionEngine, type AgentAction, type Risk } from "../electron/permissions";
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
  /** Permission engine enforced for daemon-owned agent sessions. */
  permissionEngine?: PermissionEngine;
  /** HookManager used by the daemon-owned PiHost. Mutating this is what
   *  makes `pre_tool_use` / `post_tool_use` actually fire on the PiHost side
   *  in daemon mode. */
  hookManager?: HookManager;
}

export interface DaemonServer {
  address(): { port: number; host?: string } | { socketPath: string };
  /** Current server-owned state. Treat as read-only. */
  state(): DaemonState;
  /** Run one background-policy tick now (also runs automatically on the timer). */
  tick(now?: number): Promise<void>;
  /** Request interactive approval for an agent action; resolves true to allow. */
  requestApproval(action: AgentAction, risk: Risk): Promise<boolean>;
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

  // Approvals raised by the daemon-owned PiHost are routed to connected
  // clients (the Electron thin client forwards them to the renderer). The
  // first client to answer wins; an unanswered ask fails closed on timeout.
  const pendingApprovals = new Map<
    string,
    { action: AgentAction; resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }
  >();

  const permissionSnapshot = (): { mode: string; rules: unknown[] } =>
    options.permissionEngine
      ? { mode: options.permissionEngine.getMode(), rules: options.permissionEngine.listRules() }
      : { mode: "auto", rules: [] };

  const requestApproval = (action: AgentAction, risk: Risk): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const id = randomUUID();
      const timeoutMs = Number(process.env.PIDECK_APPROVAL_TIMEOUT_MS) || 15 * 60_000;
      const timer = setTimeout(() => {
        pendingApprovals.delete(id);
        resolve(false);
      }, timeoutMs);
      timer.unref();
      pendingApprovals.set(id, { action, resolve, timer });
      broadcast("approval.requested", { id, action, risk });
    });

  const resolveApproval = (id: string, choice: string): void => {
    const pending = pendingApprovals.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingApprovals.delete(id);
    if (options.permissionEngine) {
      applyApproval(options.permissionEngine, pending.action, choice as never);
    }
    pending.resolve(choice !== "deny");
    broadcast("permissions.changed", permissionSnapshot());
  };

  // If a PiHost was supplied, wire its events to daemon broadcast so Electron
  // thin clients receive live agent streaming.
  if (options.piHost) {
    const piHost = options.piHost as unknown as { opts: { onEvent: (ev: unknown) => void; onStatus: (s: unknown) => void } };
    piHost.opts.onEvent = (ev: unknown) => broadcast("pi.event", ev);
    piHost.opts.onStatus = (s: unknown) => broadcast("pi.session.status", s);
  }

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

    // Permission system: the daemon is the enforcement point for agent tool
    // calls when it owns PiHost. Clients (the Electron thin client) read and
    // mutate policy here, and resolve approvals raised by the daemon.
    if (request.type === "permissions.get") {
      send(socket, createEnvelope("response", "permissions.get", permissionSnapshot(), request.id));
      return;
    }

    if (request.type === "permissions.set-mode") {
      const engine = options.permissionEngine;
      if (!engine) {
        send(socket, createEnvelope("response", "error", { error: "permission engine not available in daemon" }, request.id));
        return;
      }
      const { mode } = (request.payload ?? {}) as { mode?: string };
      if (mode !== "supervised" && mode !== "auto" && mode !== "full_access") {
        send(socket, createEnvelope("response", "error", { error: "invalid execution mode" }, request.id));
        return;
      }
      void (async () => {
        try {
          await engine.setModeAndPersist(mode);
          // Full Access retroactively releases asks already waiting, exactly like
          // the in-process Electron path, so agents are not left blocked.
          if (mode === "full_access") {
            for (const [id, pending] of [...pendingApprovals]) {
              clearTimeout(pending.timer);
              pendingApprovals.delete(id);
              pending.resolve(true);
              broadcast("approval.cleared", { id });
            }
          }
          send(socket, createEnvelope("response", "permissions.set-mode", { mode: engine.getMode() }, request.id));
          broadcast("permissions.changed", permissionSnapshot());
        } catch (err) {
          send(socket, createEnvelope("response", "error", { error: err instanceof Error ? err.message : String(err) }, request.id));
        }
      })();
      return;
    }

    if (request.type === "permissions.add-rule") {
      const engine = options.permissionEngine;
      if (!engine) {
        send(socket, createEnvelope("response", "error", { error: "permission engine not available in daemon" }, request.id));
        return;
      }
      const input = request.payload as { category?: string; decision?: string; scope?: string; match?: unknown; note?: unknown };
      if (!input || typeof input.category !== "string" || (input.decision !== "allow" && input.decision !== "deny")) {
        send(socket, createEnvelope("response", "error", { error: "invalid rule" }, request.id));
        return;
      }
      if (input.scope !== "always" && input.scope !== "session") {
        send(socket, createEnvelope("response", "error", { error: "invalid rule scope" }, request.id));
        return;
      }
      const rule = engine.addRule({
        category: input.category as never,
        decision: input.decision,
        scope: input.scope,
        match: input.match as never,
        note: input.note as never,
      });
      send(socket, createEnvelope("response", "permissions.add-rule", rule, request.id));
      broadcast("permissions.changed", permissionSnapshot());
      return;
    }

    if (request.type === "permissions.remove-rule") {
      const engine = options.permissionEngine;
      if (!engine) {
        send(socket, createEnvelope("response", "error", { error: "permission engine not available in daemon" }, request.id));
        return;
      }
      const { id } = (request.payload ?? {}) as { id?: string };
      if (!id || typeof id !== "string") {
        send(socket, createEnvelope("response", "error", { error: "permissions.remove-rule requires { id }" }, request.id));
        return;
      }
      const removed = engine.removeRule(id);
      send(socket, createEnvelope("response", "permissions.remove-rule", { id, ok: true, removed }, request.id));
      if (removed) broadcast("permissions.changed", permissionSnapshot());
      return;
    }

    if (request.type === "approval.resolved") {
      const { id, choice } = (request.payload ?? {}) as { id?: string; choice?: string };
      const validChoice =
        choice === "allow_once" || choice === "allow_session" || choice === "allow_always" || choice === "deny";
      if (!id || !validChoice) {
        send(socket, createEnvelope("response", "error", { error: "approval.resolved requires { id, choice }" }, request.id));
        return;
      }
      resolveApproval(id, choice);
      send(socket, createEnvelope("response", "approval.resolved", { id, ok: true }, request.id));
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
          switch ((request as any).type as string) {
            case "pi.getState":
              payload = await piHost.getState();
              break;
            case "pi.getMessages":
              payload = await piHost.getMessages();
              break;
            case "pi.getStats":
              payload = await piHost.getStats();
              break;
            case "pi.getCommands":
              payload = await (piHost as any).getCommands();
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
            case "pi.notifyDiagnostics": {
              const { diagnostics } = request.payload as { diagnostics: unknown[] };
              await piHost.notifyDiagnostics(diagnostics as never);
              payload = { ok: true };
              break;
            }
            case "pi.getToolOutput": {
              const { toolCallId } = request.payload as { toolCallId: string };
              payload = await piHost.getToolOutput(toolCallId);
              break;
            }
            case "pi.getModels":
              payload = await piHost.getModels();
              break;
            case "pi.setModel": {
              const { provider, modelId } = request.payload as { provider: string; modelId: string };
              payload = await piHost.setModel(provider, modelId);
              break;
            }
            case "pi.getThinkingLevels":
              payload = await piHost.getThinkingLevels();
              break;
            case "pi.setThinking": {
              const { level } = request.payload as { level: string };
              payload = await piHost.setThinking(level);
              break;
            }
            case "pi.getSettings":
              payload = await piHost.getSettings();
              break;
            case "pi.setSettings": {
              const { patch } = request.payload as { patch: unknown };
              payload = await piHost.setSettings(patch as any);
              break;
            }
            case "pi.setSessionName": {
              const { name } = request.payload as { name: string };
              payload = await piHost.setSessionName(name);
              break;
            }
            case "pi.compact":
              payload = await piHost.compact();
              break;
            case "pi.getTree":
              payload = await piHost.getTree();
              break;
            case "pi.getHistory":
              payload = await piHost.getHistory();
              break;
            case "pi.getTurnChanges": {
              const { entryId } = request.payload as { entryId: string };
              payload = await piHost.getTurnChanges(entryId);
              break;
            }
            case "pi.getTurnFileDiff": {
              const { entryId, path } = request.payload as { entryId: string; path: string };
              payload = await piHost.getTurnFileDiff(entryId, path);
              break;
            }
            case "pi.prepareRollback": {
              const { entryId } = request.payload as { entryId: string };
              payload = await piHost.prepareRollback(entryId);
              break;
            }
            case "pi.commitRollback": {
              const { planId } = request.payload as { planId: string };
              payload = await piHost.commitRollback(planId);
              break;
            }
            case "pi.undoRollback":
              payload = await piHost.undoRollback();
              break;
            case "pi.getForkMessages":
              payload = await piHost.getForkMessages();
              break;
            case "pi.fork": {
              const { entryId } = request.payload as { entryId: string };
              payload = await piHost.fork(entryId);
              break;
            }
            case "pi.clone":
              payload = await piHost.clone();
              break;
            case "pi.generateCommitMessage": {
              const { context } = request.payload as { context: unknown };
              payload = await (piHost as any).generateGitCommitMessage(context);
              break;
            }
            case "pi.getRecaps": {
              const { sessionFile } = request.payload as { sessionFile: string };
              payload = await piHost.getRecaps(sessionFile);
              break;
            }
            case "pi.refreshFromDisk": {
              const { sessionFile } = request.payload as { sessionFile: string };
              payload = { refreshed: await piHost.refreshFromDisk(sessionFile) };
              break;
            }
            case "pi.switchTo" as any: {
              const { sessionFile } = request.payload as { sessionFile: string };
              payload = await (piHost as any).switchTo(sessionFile);
              break;
            }
            case "pi.getActiveSessionFile" as any: {
              payload = { path: (piHost as any).activeSessionFile ?? null };
              break;
            }
            case "pi.controlThread" as any: {
              const { action, threadId, message } = request.payload as { action: "steer" | "follow-up" | "stop"; threadId: string; message?: string };
              payload = await (piHost as any).controlThread(action, threadId, message);
              break;
            }
            case "pi.promoteThread" as any: {
              const { threadId } = request.payload as { threadId: string };
              payload = await (piHost as any).promoteThread(threadId);
              break;
            }
            case "pi.controlSubagent" as any: {
              const { action, runId, message } = request.payload as { action: "steer" | "follow-up" | "stop"; runId: string; message?: string };
              payload = await (piHost as any).controlSubagent(action, runId, message);
              break;
            }
            case "pi.promoteSubagent" as any: {
              const { runId } = request.payload as { runId: string };
              payload = await (piHost as any).promoteSubagent(runId);
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

    if ((request as any).type === "hooks.register") {
      const hook = (request as any).payload as HookDefinition;
      if (options.hookManager) {
        options.hookManager.register(hook);
      }
      const beforeHooks = state.runtime.hooks;
      const afterHooks = registerHook(beforeHooks, hook);
      if (afterHooks !== beforeHooks) {
        state = { ...state, runtime: { ...state.runtime, hooks: afterHooks } };
        persist();
        broadcast("hooks.updated" as any, afterHooks as any, socket);
      }
      send(socket, createEnvelope("response", "hooks.register" as any, { ok: true } as any, request.id));
      return;
    }
    if ((request as any).type === "hooks.remove") {
      const { id } = (request as any).payload as { id: string };
      if (options.hookManager) {
        options.hookManager.remove(id);
      }
      const beforeHooks = state.runtime.hooks;
      const afterHooks = removeHook(beforeHooks, id);
      if (afterHooks !== beforeHooks) {
        state = { ...state, runtime: { ...state.runtime, hooks: afterHooks } };
        persist();
        broadcast("hooks.updated" as any, afterHooks as any, socket);
      }
      send(socket, createEnvelope("response", "hooks.remove" as any, { ok: true, removed: afterHooks !== beforeHooks } as any, request.id));
      return;
    }

    // Everything else goes through the pure dispatch core (ping, task.*,
    // attention.*, contract.registered). Unsupported types come back as
    // explicit errors.
    const before = state.runtime;
    const result = dispatchRequest(before, request);
    state = { ...state, runtime: result.runtime };
    send(socket, result.response);
    if (result.runtime !== before && result.response.type !== "error") {
      persist();
      broadcast(result.response.type, result.response.payload, socket);
      // A blocked task.complete raised failed_task attention inside the
      // dispatch; surface it as an attention.raised event so clients watching
      // the attention channel see the new item like any other raise.
      if (
        result.response.type === "task.complete" &&
        (result.response.payload as { blocked?: boolean })?.blocked === true &&
        (result.response.payload as { attention?: unknown })?.attention
      ) {
        broadcast("attention.raised", (result.response.payload as { attention: unknown }).attention, socket);
      }
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
    requestApproval,
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
