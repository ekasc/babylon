// Babylon event model (Cross-cutting infrastructure).
//
// Significant runtime activity is normalized into stable events with stable
// ids and explicit ownership references. This is not full event sourcing: the
// registries remain authoritative. The point is a stable contract at subsystem
// boundaries so a future daemon can replay and project reliable state, and so
// every asynchronous system speaks the same vocabulary.
//
// TODO(authority): the log currently lives in the renderer because PiHost
// state does. When runtime/daemon ownership moves, authoritative event
// ingestion should move with it — this module's contracts are designed to
// survive that move unchanged.

import { makeId } from "./runtime";

// Real producers today: message.sent (renderer send path), turn.* and tool.*
// (Pi agent events), approval.* (permission engine via IPC), checkpoint.created
// (PiHost rollback capture via pideck_checkpoint_created), plan.*
// (PlansPanel lifecycle), attention.* (attention registry transitions).
// process.started/exited and task.blocked/completed have NO real producer yet:
// the only process "spawns" are a demo simulation and the task model is pure
// state without a runtime. Simulation paths must not emit production events;
// wire these when real runtimes land.
export const EVENT_TYPES = [
  "message.sent",
  "turn.started",
  "turn.completed",
  "tool.started",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
  "process.started",
  "process.exited",
  "checkpoint.created",
  "plan.proposed",
  "plan.approved",
  "task.blocked",
  "task.completed",
  "attention.created",
  "attention.resolved",
] as const;

export type BabylonEventType = (typeof EVENT_TYPES)[number];

export const OWNERSHIP_KEYS = [
  "projectId",
  "taskId",
  "sessionId",
  "agentId",
  "turnId",
  "toolRunId",
  "processId",
  "worktreeId",
] as const;

export type OwnershipKey = (typeof OWNERSHIP_KEYS)[number];

export type OwnershipRef = Partial<Record<OwnershipKey, string>>;

/**
 * Typed payload shape per event type. Payloads carry identifiers and small
 * primitives only — never prompt text, tool output, source, tokens, or
 * secrets — so events stay safe for diagnostics export. Subject-based events
 * (approval/checkpoint/plan/attention) require their entity id as `id`, which
 * is also what subject resolution reads.
 */
export interface BabylonEventPayloadMap {
  "message.sent": { messageId?: string };
  "turn.started": { turnId?: string };
  "turn.completed": { turnId?: string };
  "tool.started": { toolCallId?: string };
  "tool.completed": { toolCallId?: string; isError?: boolean };
  "approval.requested": { id: string };
  "approval.resolved": { id: string; decision: string };
  "process.started": { id?: string };
  "process.exited": { id?: string; exitCode?: number };
  "checkpoint.created": { id: string };
  "plan.proposed": { id: string };
  "plan.approved": { id: string };
  "task.blocked": { id?: string; reason?: string };
  "task.completed": { id?: string };
  "attention.created": { id: string };
  "attention.resolved": { id: string };
}

/**
 * Runtime mirror of BabylonEventPayloadMap (types cannot be read at runtime).
 * Field names map to a primitive type name; `required` fields must be present
 * with that exact type. Keep the two definitions in sync.
 */
const EVENT_PAYLOAD_CONTRACTS: Record<BabylonEventType, { required?: Record<string, string>; optional?: Record<string, string> }> = {
  "message.sent": { optional: { messageId: "string" } },
  "turn.started": { optional: { turnId: "string" } },
  "turn.completed": { optional: { turnId: "string" } },
  "tool.started": { optional: { toolCallId: "string" } },
  "tool.completed": { optional: { toolCallId: "string", isError: "boolean" } },
  "approval.requested": { required: { id: "string" } },
  "approval.resolved": { required: { id: "string", decision: "string" } },
  "process.started": { optional: { id: "string" } },
  "process.exited": { optional: { id: "string", exitCode: "number" } },
  "checkpoint.created": { required: { id: "string" } },
  "plan.proposed": { required: { id: "string" } },
  "plan.approved": { required: { id: "string" } },
  "task.blocked": { optional: { id: "string", reason: "string" } },
  "task.completed": { optional: { id: "string" } },
  "attention.created": { required: { id: "string" } },
  "attention.resolved": { required: { id: "string" } },
};

/** Keys that must never appear in a payload crossing a trust boundary. */
const DANGEROUS_PAYLOAD_KEYS = new Set(["__proto__", "proto", "prototype", "constructor"]);

export interface BabylonEvent {
  /** Stable event id, minted once and never reused. */
  id: string;
  type: BabylonEventType;
  ts: number;
  /** Ownership references; every event names what it belongs to. */
  owner: OwnershipRef;
  payload: Record<string, unknown>;
}

export interface EventLog {
  events: BabylonEvent[];
}

export function createEventLog(): EventLog {
  return { events: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPayloadPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Payloads are flat primitive maps; nested structures are rejected outright. */
function checkPayload(type: BabylonEventType, payload: Record<string, unknown>): string | null {
  for (const key of Object.keys(payload)) {
    if (DANGEROUS_PAYLOAD_KEYS.has(key)) return `payload key ${key} is not allowed`;
    if (!isPayloadPrimitive(payload[key])) return `payload ${key} must be a primitive`;
  }
  const contract = EVENT_PAYLOAD_CONTRACTS[type];
  for (const [field, expected] of Object.entries(contract.required ?? {})) {
    const value = payload[field];
    if (typeof value !== expected) {
      return `${type} payload requires non-empty ${field}: ${expected}`;
    }
    if (typeof value === "string" && value.trim().length === 0) {
      return `${type} payload requires non-empty ${field}: ${expected}`;
    }
  }
  for (const [field, expected] of Object.entries(contract.optional ?? {})) {
    const value = payload[field];
    if (value !== undefined && value !== null && typeof value !== expected) {
      return `payload ${field} must be ${expected}`;
    }
  }
  return null;
}

/** Validate one event shape; returns the error message or null when valid. */
export function validateEvent(event: unknown): string | null {
  if (!isPlainObject(event)) return "event must be an object";
  if (typeof event.id !== "string" || event.id.trim().length === 0) return "event needs a non-empty id";
  if (!EVENT_TYPES.includes(event.type as BabylonEventType)) {
    return `unknown event type ${String(event.type)}`;
  }
  if (typeof event.ts !== "number" || !Number.isFinite(event.ts)) return "event needs a finite ts";
  if (event.owner !== undefined) {
    if (!isPlainObject(event.owner)) return "event owner must be an object";
    for (const [key, value] of Object.entries(event.owner)) {
      if (!OWNERSHIP_KEYS.includes(key as OwnershipKey)) return `unknown ownership key ${key}`;
      if (typeof value !== "string" || value.length === 0) return `ownership ${key} must be a non-empty string`;
    }
  }
  // Payloads are trusted internal data: they carry ids and counts, never
  // prompt text or tool output (diagnostics depends on that guarantee).
  // Contracts pin the shape per event type and dangerous keys are rejected
  // because events cross the IPC trust boundary.
  if (event.payload !== undefined) {
    if (!isPlainObject(event.payload)) return "event payload must be an object";
    const problem = checkPayload(event.type as BabylonEventType, event.payload);
    if (problem) return problem;
  }
  return null;
}

/**
 * Append one event. The log is append-only: duplicate ids are rejected rather
 * than overwritten, and malformed events are refused so a bad producer cannot
 * poison replay. Ids are trimmed before the duplicate check so "e1" and " e1 "
 * cannot coexist. The event, its owner stamp, and its payload are copied so a
 * caller-held reference cannot mutate appended history. Duplicate detection is
 * a linear scan; fine for the bounded diagnostics volumes this log holds.
 */
export function appendEvent(log: EventLog, event: BabylonEvent): EventLog | string {
  const problem = validateEvent(event);
  if (problem) return problem;
  const normalized: BabylonEvent = {
    ...event,
    id: event.id.trim(),
    owner: { ...event.owner },
    payload: { ...event.payload },
  };
  if (log.events.some((e) => e.id === normalized.id)) return `event ${normalized.id} already exists`;
  return { events: [...log.events, normalized] };
}

export function newEventId(): string {
  return makeId("evt");
}

/**
 * Central event construction: mints the id, normalizes ownership (blank or
 * whitespace-only values are dropped), copies the payload, and defaults the
 * timestamp to now. Callers still choose ownership explicitly — the helper
 * never guesses it. Payload objects are type-checked against
 * BabylonEventPayloadMap at compile time and re-validated on append.
 */
export function createBabylonEvent<T extends BabylonEventType>(
  type: T,
  opts: { owner?: OwnershipRef; payload?: BabylonEventPayloadMap[T]; ts?: number }
): BabylonEvent {
  const owner: OwnershipRef = {};
  for (const key of OWNERSHIP_KEYS) {
    const value = opts.owner?.[key];
    if (typeof value === "string" && value.trim().length > 0) owner[key] = value;
  }
  return {
    id: newEventId(),
    type,
    ts: opts.ts ?? Date.now(),
    owner,
    payload: { ...(opts.payload ?? {}) },
  };
}

export interface EventFilter {
  types?: BabylonEventType[];
  owner?: OwnershipRef;
}

export function listEvents(log: EventLog, filter?: EventFilter): BabylonEvent[] {
  return log.events.filter((event) => {
    if (filter?.types && !filter.types.includes(event.type)) return false;
    if (filter?.owner) {
      for (const key of OWNERSHIP_KEYS) {
        const expected = filter.owner[key];
        if (expected !== undefined && event.owner[key] !== expected) return false;
      }
    }
    return true;
  });
}
