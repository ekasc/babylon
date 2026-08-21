// Babylon event model (Cross-cutting infrastructure).
//
// Significant runtime activity is normalized into stable events with stable
// ids and explicit ownership references. This is not full event sourcing: the
// registries remain authoritative. The point is a stable contract at subsystem
// boundaries so a future daemon can replay and project reliable state, and so
// every asynchronous system speaks the same vocabulary.

import { makeId } from "./runtime";

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
  if (event.payload !== undefined && !isPlainObject(event.payload)) return "event payload must be an object";
  return null;
}

/**
 * Append one event. The log is append-only: duplicate ids are rejected rather
 * than overwritten, and malformed events are refused so a bad producer cannot
 * poison replay.
 */
export function appendEvent(log: EventLog, event: BabylonEvent): EventLog | string {
  const problem = validateEvent(event);
  if (problem) return problem;
  if (log.events.some((e) => e.id === event.id)) return `event ${event.id} already exists`;
  return { events: [...log.events, event] };
}

export function newEventId(): string {
  return makeId("evt");
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
