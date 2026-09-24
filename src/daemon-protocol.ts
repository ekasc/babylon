// Babylon daemon protocol for Phase 6 (Control Plane, Feature 13).
//
// The runtime is extracted so the desktop and a future Babylon daemon talk over
// a typed local protocol. The ROADMAP requires that "protocol events carry
// stable task/session/tool IDs" and that the protocol be typed. This module is
// that contract: a versioned envelope with a stable message id, a discriminated
// set of well-known message types, and strict parsing so malformed frames are
// rejected rather than silently mis-handled.

import { makeId } from "./runtime";

export type ProtocolKind = "request" | "response" | "event";

// Bumped whenever the request/response contract changes shape. The desktop app
// and the daemon are separate processes that survive updates independently, so
// a client that connects to a daemon built from different source must retire it
// rather than speak a mismatched protocol. See `daemon.shutdown`.
export const DAEMON_PROTOCOL_VERSION = 2;

/** What a live daemon advertises about itself on ping. */
export type DaemonAdvertised = { protocol?: unknown; build?: unknown; draining?: unknown };

/**
 * Whether the socket holder must go before use. Protocol mismatch is
 * definitive. Builds are content-hashed at bundle time, so equal versions
 * with different builds are still skew: the dev watcher rebuilds the
 * Electron side on every save while the daemon bundle only rebuilds on
 * demand. A daemon that predates build ids counts as mismatched (fail
 * closed); an unknown own id means this side cannot compare, so it keeps.
 */
export function shouldRetireDaemon(
  running: DaemonAdvertised | undefined,
  ours: { protocol: number; build: string }
): boolean {
  if (!running) return false;
  // A draining holder exits on its own within seconds; retire waits it out
  // through the normal shutdown path instead of adopting a dying daemon.
  if (running.draining === true) return true;
  if (running.protocol !== ours.protocol) return true;
  if (ours.build === "unknown") return false;
  return running.build !== ours.build;
}

// The single source of truth for message types. The string union is derived
// from this list so adding a member cannot silently drift from the validator.
export const KNOWN_MESSAGE_TYPES = [
  "session.created",
  "session.updated",
  "session.removed",
  "task.created",
  "task.updated",
  "task.removed",
  "task.complete",
  "approval.requested",
  "approval.resolved",
  "approval.cleared",
  "approval.list",
  "permissions.get",
  "permissions.set-mode",
  "permissions.add-rule",
  "permissions.remove-rule",
  "permissions.changed",
  "process.spawned",
  "process.updated",
  "process.removed",
  "worktree.created",
  "attention.raised",
  "attention.resolved",
  "hook.fired",
  "automation.registered",
  "automation.removed",
  "automation.ran",
  "policy.updated",
  "state.get",
  "state.snapshot",
  "daemon.auth",
  "daemon.shutdown",
  "remote.auth",
  "remote.tasks.list",
  "remote.state.view",
  "remote.attention.resolve",
  "remote.question.answer",
  "remote.task.stop_resume",
  "remote.diffs.view",
  "pi.prompt",
  "pi.abort",
  "pi.getState",
  "pi.getMessages",
  "pi.getStats",
  "pi.goalControl",
  "pi.executionList",
  "pi.executionActivate",
  "pi.relocateExecution",
  "pi.executionDeactivate",
  "pi.executionChanged",
  "pi.goalBeginPrompt",
  "pi.designControl",
  "pi.designGetArtifact",
  "pi.designApproveArtifact",
  "pi.designBeginPrompt",
  "pi.notifyDiagnostics",
  "pi.event",
  "pi.ui.respond",
  "pi.getToolOutput",
  "pi.getModels",
  "pi.warmProject",
  "pi.setModel",
  "pi.getThinkingLevels",
  "pi.setThinking",
  "pi.getSettings",
  "pi.setSettings",
  "pi.setSessionName",
  "pi.renameSession",
  "pi.compact",
  "pi.getTree",
  "pi.getHistory",
  "pi.getTurnChanges",
  "pi.getTurnFileDiff",
  "pi.prepareRollback",
  "pi.commitRollback",
  "pi.undoRollback",
  "pi.getForkMessages",
  "pi.fork",
  "pi.clone",
  "pi.generateCommitMessage",
  "pi.getRecaps",
  "pi.refreshFromDisk",
  "pi.getCommands",
  "pi.controlThread",
  "pi.promoteThread",
  "pi.controlSubagent",
  "pi.promoteSubagent",
  "hooks.register",
  "hooks.remove",
  "hooks.updated",
  "contract.registered",
  "contract.get",
  "contract.list",
  "ping",
  "pong",
  "error",
] as const;

export type ProtocolMessageType = (typeof KNOWN_MESSAGE_TYPES)[number];

// ping/pong are the only messages allowed to carry no structured payload. Every
// other type must carry an object payload so consumers are not handed an
// untrusted scalar at this boundary.
const NO_PAYLOAD_TYPES: readonly ProtocolMessageType[] = ["ping", "pong"];

/**
 * An envelope payload: a JSON object. Arrays and scalars are rejected here and
 * by `validatePayload`, so a handler's raw result cannot be sent as-is without
 * being wrapped in a named object. This is the type-level half of the same rule
 * that `validatePayload` enforces at runtime.
 */
export type ProtocolPayload = Record<string, unknown>;

export interface ProtocolEnvelope {
  /** Stable message id (minted once, carried end to end). */
  id: string;
  kind: ProtocolKind;
  type: ProtocolMessageType;
  payload: ProtocolPayload;
  /** Links a request/response pair. */
  inReplyTo?: string;
  /** Epoch milliseconds. */
  ts: number;
}

function validatePayload(type: ProtocolMessageType, payload: unknown): void {
  if (NO_PAYLOAD_TYPES.includes(type)) return;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Invalid protocol envelope: payload for ${type} must be an object`);
  }
}

/** Narrow an arbitrary value to a payload, rejecting arrays and scalars. The
 *  single place a payload cast is allowed, and it is checked first. */
export function toPayload(value: unknown): ProtocolPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid protocol payload: must be an object");
  }
  return value as ProtocolPayload;
}

/** Payload for a type whose payload is optional (ping/pong): absent becomes an
 *  empty object, present is still required to be an object. pong carries
 *  `{ ok, protocol }`, so it must not be flattened away. */
function optionalPayload(value: unknown): ProtocolPayload {
  return value === undefined || value === null ? {} : toPayload(value);
}

function validateInReplyTo(inReplyTo: unknown): string | undefined {
  if (inReplyTo === undefined) return undefined;
  if (typeof inReplyTo !== "string" || inReplyTo.trim().length === 0) {
    throw new Error("Invalid protocol envelope: bad inReplyTo");
  }
  return inReplyTo;
}

export function createEnvelope(
  kind: ProtocolKind,
  type: ProtocolMessageType,
  payload: ProtocolPayload,
  inReplyTo?: string
): ProtocolEnvelope {
  const normalizedReply = validateInReplyTo(inReplyTo);
  validatePayload(type, payload);
  return {
    id: makeId("msg"),
    kind,
    type,
    payload,
    inReplyTo: normalizedReply,
    ts: Date.now(),
  };
}

export function serializeEnvelope(envelope: ProtocolEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Parse and validate an envelope from JSON. Rejects missing/null/array input,
 * a bad/missing/whitespace-only stable id, a non-enum kind, an unknown message
 * type, a non-finite timestamp, a malformed inReplyTo, and a missing/non-object
 * payload for data-bearing message types. Returns a normalized envelope (unknown
 * keys dropped, inReplyTo dropped when absent) on success.
 */
export function parseEnvelope(json: string): ProtocolEnvelope {
  let v: Partial<ProtocolEnvelope>;
  try {
    v = JSON.parse(json) as Partial<ProtocolEnvelope>;
  } catch {
    throw new Error("Invalid protocol envelope: malformed JSON");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("Invalid protocol envelope: input is not an object");
  }
  if (typeof v.id !== "string") {
    throw new Error("Invalid protocol envelope: bad id type");
  }
  if (v.id.trim().length === 0) {
    throw new Error("Invalid protocol envelope: missing stable id");
  }
  if (v.kind !== "request" && v.kind !== "response" && v.kind !== "event") {
    throw new Error(`Invalid protocol envelope: bad kind ${String(v.kind)}`);
  }
  if (v.type === undefined || !KNOWN_MESSAGE_TYPES.includes(v.type)) {
    throw new Error(`Invalid protocol envelope: unknown type ${String(v.type)}`);
  }
  if (typeof v.ts !== "number" || !Number.isFinite(v.ts)) {
    throw new Error("Invalid protocol envelope: missing or non-finite ts");
  }
  const type = v.type;
  const inReplyTo = validateInReplyTo(v.inReplyTo);
  validatePayload(type, v.payload);
  return {
    id: v.id,
    kind: v.kind,
    type,
    // ping/pong may omit a payload; normalize absence to an empty object so
    // the envelope payload type stays object-only for every consumer. A present
    // payload is preserved (pong carries { ok, protocol }).
    payload: NO_PAYLOAD_TYPES.includes(type) ? optionalPayload(v.payload) : toPayload(v.payload),
    inReplyTo,
    ts: v.ts,
  };
}
