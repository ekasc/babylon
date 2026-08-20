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

// Well-known message types crossing the daemon<->desktop boundary. Each event
// carries, in its payload, the stable task/session/tool id it concerns.
export type ProtocolMessageType =
  | "session.created"
  | "session.updated"
  | "session.removed"
  | "task.created"
  | "task.updated"
  | "task.removed"
  | "approval.requested"
  | "approval.resolved"
  | "process.spawned"
  | "process.updated"
  | "process.removed"
  | "worktree.created"
  | "attention.raised"
  | "attention.resolved"
  | "hook.fired"
  | "ping"
  | "pong";

export const KNOWN_MESSAGE_TYPES: readonly ProtocolMessageType[] = [
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
  "ping",
  "pong",
];

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

export function createEnvelope(
  kind: ProtocolKind,
  type: ProtocolMessageType,
  payload: unknown,
  inReplyTo?: string
): ProtocolEnvelope {
  return {
    id: makeId("msg"),
    kind,
    type,
    payload,
    inReplyTo,
    ts: Date.now(),
  };
}

export function serializeEnvelope(envelope: ProtocolEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Parse and validate an envelope from JSON. Rejects missing/null/array input,
 * missing or empty stable id, a non-enum kind, an unknown message type, a
 * non-finite timestamp, and a malformed inReplyTo. Returns a normalized
 * envelope (inReplyTo dropped when absent) on success.
 */
export function parseEnvelope(json: string): ProtocolEnvelope {
  const v = JSON.parse(json) as Partial<ProtocolEnvelope>;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("Invalid protocol envelope: input is not an object");
  }
  if (typeof v.id !== "string" || v.id.length === 0) {
    throw new Error("Invalid protocol envelope: missing stable id");
  }
  if (v.kind !== "request" && v.kind !== "response" && v.kind !== "event") {
    throw new Error(`Invalid protocol envelope: bad kind ${String(v.kind)}`);
  }
  if (!KNOWN_MESSAGE_TYPES.includes(v.type as ProtocolMessageType)) {
    throw new Error(`Invalid protocol envelope: unknown type ${String(v.type)}`);
  }
  if (typeof v.ts !== "number" || !Number.isFinite(v.ts)) {
    throw new Error("Invalid protocol envelope: missing or non-finite ts");
  }
  if (v.inReplyTo !== undefined && (typeof v.inReplyTo !== "string" || v.inReplyTo.length === 0)) {
    throw new Error("Invalid protocol envelope: bad inReplyTo");
  }
  return {
    id: v.id,
    kind: v.kind,
    type: v.type as ProtocolMessageType,
    payload: v.payload,
    inReplyTo: v.inReplyTo,
    ts: v.ts,
  };
}
