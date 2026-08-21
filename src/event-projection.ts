// Event replay and projection (Cross-cutting infrastructure).
//
// A projection rebuilds a coarse view of the world purely from the event
// stream: no registry access, no live state. If the projection can answer
// "what happened to task X", the event contract is doing its job. Projections
// are deterministic: the same events always produce the same view.

import type { BabylonEvent, BabylonEventType, OwnershipKey, OwnershipRef } from "./events";
import { OWNERSHIP_KEYS } from "./events";

export interface TaskProjection {
  blockedAt?: number;
  completedAt?: number;
  lastActivityAt?: number;
}

export interface AttentionProjection {
  createdAt: number;
  resolvedAt?: number;
}

export interface ProcessProjection {
  startedAt: number;
  exitedAt?: number;
  exitPayload?: Record<string, unknown>;
}

export interface RuntimeProjection {
  tasks: Record<string, TaskProjection>;
  attention: Record<string, AttentionProjection>;
  processes: Record<string, ProcessProjection>;
  plans: Record<string, { proposedAt: number; approvedAt?: number }>;
  counts: Partial<Record<BabylonEventType, number>>;
  firstTs?: number;
  lastTs?: number;
}

export function projectEvents(events: BabylonEvent[]): RuntimeProjection {
  const projection: RuntimeProjection = { tasks: {}, attention: {}, processes: {}, plans: {}, counts: {} };
  for (const event of events) {
    projection.counts[event.type] = (projection.counts[event.type] ?? 0) + 1;
    // Earliest and latest event times, independent of replay order.
    projection.firstTs = projection.firstTs === undefined ? event.ts : Math.min(projection.firstTs, event.ts);
    projection.lastTs = projection.lastTs === undefined ? event.ts : Math.max(projection.lastTs, event.ts);
    const subjectId = subjectOf(event);
    switch (event.type) {
      case "task.blocked":
      case "task.completed": {
        // Merge field-by-field so replay order cannot change the result.
        const task = { ...projection.tasks[subjectId] };
        if (event.type === "task.blocked") task.blockedAt = event.ts;
        else task.completedAt = event.ts;
        task.lastActivityAt =
          task.lastActivityAt === undefined ? event.ts : Math.max(task.lastActivityAt, event.ts);
        projection.tasks[subjectId] = task;
        break;
      }
      case "attention.created": {
        const existing = projection.attention[subjectId];
        projection.attention[subjectId] = { ...existing, createdAt: event.ts };
        break;
      }
      case "attention.resolved": {
        const existing = projection.attention[subjectId];
        projection.attention[subjectId] = {
          createdAt: existing?.createdAt ?? event.ts,
          resolvedAt: event.ts,
        };
        break;
      }
      case "process.started": {
        const existing = projection.processes[subjectId];
        projection.processes[subjectId] = { ...existing, startedAt: event.ts };
        break;
      }
      case "process.exited": {
        const proc = projection.processes[subjectId] ?? { startedAt: event.ts };
        proc.exitedAt = event.ts;
        proc.exitPayload = event.payload;
        projection.processes[subjectId] = proc;
        break;
      }
      case "plan.proposed": {
        const existing = projection.plans[subjectId];
        projection.plans[subjectId] = { ...existing, proposedAt: event.ts };
        break;
      }
      case "plan.approved": {
        const plan = projection.plans[subjectId] ?? { proposedAt: event.ts };
        plan.approvedAt = event.ts;
        projection.plans[subjectId] = plan;
        break;
      }
      default:
        break; // message/turn/tool/approval/checkpoint events count only.
    }
  }
  return projection;
}

/**
 * The id an event is "about". Events carry their subject in the payload under
 * a conventional key matching the most specific ownership reference; tasks use
 * taskId, attention uses its own item id, and so on.
 */
function subjectOf(event: BabylonEvent): string {
  for (const key of ["taskId", "processId", "sessionId"] as const) {
    const value = event.owner[key];
    if (value) return value;
  }
  const payloadId = event.payload.id;
  return typeof payloadId === "string" ? payloadId : `${event.type}:${event.id}`;
}

/** Ownership coverage: how many events name each kind of owner. */
export function ownershipCoverage(events: BabylonEvent[]): Record<OwnershipKey, number> {
  const coverage = Object.fromEntries(OWNERSHIP_KEYS.map((k) => [k, 0])) as Record<OwnershipKey, number>;
  for (const event of events) {
    for (const key of OWNERSHIP_KEYS) {
      if (typeof event.owner[key] === "string" && event.owner[key].length > 0) coverage[key] += 1;
    }
  }
  return coverage;
}

export type OwnerRefInput = OwnershipRef;

export function ownerMatches(event: BabylonEvent, ref: OwnerRefInput): boolean {
  return Object.entries(ref).every(([key, value]) => event.owner[key as OwnershipKey] === value);
}
