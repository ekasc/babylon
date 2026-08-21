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

// The single source of truth for message types. The string union is derived
// from this list so adding a member cannot silently drift from the validator.
export const KNOWN_MESSAGE_TYPES = [
  "session.created",
  "session.updated",
  "session.removed",
  "task.created",
  "task.updated",
  "task.removed",
  "approval.requested",
  "approval.resolved",
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
  "remote.auth",
  "remote.tasks.list",
  "remote.state.view",
  "remote.attention.resolve",
  "remote.question.answer",
  "remote.task.stop_resume",
  "remote.diffs.view",
  "ping",
  "pong",
  "error",
] as const;

export type ProtocolMessageType = (typeof KNOWN_MESSAGE_TYPES)[number];

// ping/pong are the only messages allowed to carry no structured payload. Every
// other type must carry an object payload so consumers are not handed an
// untrusted scalar at this boundary.
const NO_PAYLOAD_TYPES: readonly ProtocolMessageType[] = ["ping", "pong"];

export interface ProtocolEnvelope {
  /** Stable message id (minted once, carried end to end). */
  id: string;
  kind: ProtocolKind;
  type: ProtocolMessageType;
  payload: unknown;
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
  payload: unknown,
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
    payload: v.payload,
    inReplyTo,
    ts: v.ts,
  };
}
