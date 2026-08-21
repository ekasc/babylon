// Runtime diagnostics (Cross-cutting infrastructure).
//
// One developer-facing snapshot of system state: registry sizes, statuses,
// policy limits, event health, ownership coverage. The export is aggregates
// only by construction — no prompts, no tool output, no secrets, no source —
// so it is safe to attach to a bug report.

import type { AttentionRegistry } from "./attention";
import { listAttention } from "./attention";
import type { AutomationHistory } from "./automation-runner";
import type { BackgroundPolicy } from "./background-policy";
import type { DeviceRegistry } from "./device-pairing";
import type { EventLog } from "./events";
import { OWNERSHIP_KEYS, type OwnershipKey } from "./events";
import { ownershipCoverage } from "./event-projection";
import type { ProcessRegistry } from "./process-model";
import { listActive, listHistory } from "./process-model";
import { RUNTIME_VERSION } from "./runtime";
import type { ScheduledTaskRegistry } from "./automation";

export interface DiagnosticsInput {
  now: number;
  appVersion?: string;
  attention?: AttentionRegistry;
  processes?: ProcessRegistry;
  schedule?: ScheduledTaskRegistry;
  history?: AutomationHistory;
  policy?: BackgroundPolicy;
  devices?: DeviceRegistry;
  events?: EventLog;
}

export interface DiagnosticsSnapshot {
  generatedAt: number;
  appVersion: string;
  runtimeVersion: number;
  attention: { unresolved: number };
  processes: { active: number; exited: number };
  automation: { scheduledTasks: number; enabledTasks: number; recordedRuns: number };
  backgroundPolicy?: { mode: string; maxConcurrentAgents: number; maxBackgroundCost: number };
  devices?: { paired: number; revoked: number };
  events?: {
    total: number;
    byType: Record<string, number>;
    firstTs?: number;
    lastTs?: number;
    ownershipCoverage: Record<OwnershipKey, number>;
  };
}

export function collectDiagnostics(input: DiagnosticsInput): DiagnosticsSnapshot {
  const snapshot: DiagnosticsSnapshot = {
    generatedAt: input.now,
    appVersion: input.appVersion ?? "unknown",
    runtimeVersion: RUNTIME_VERSION,
    attention: {
      unresolved: input.attention ? listAttention(input.attention).length : 0,
    },
    processes: {
      active: input.processes ? listActive(input.processes).length : 0,
      exited: input.processes ? listHistory(input.processes).length : 0,
    },
    automation: {
      scheduledTasks: input.schedule ? Object.keys(input.schedule.tasks).length : 0,
      enabledTasks: input.schedule
        ? Object.values(input.schedule.tasks).filter((t) => t.enabled).length
        : 0,
      recordedRuns: input.history ? input.history.runs.length : 0,
    },
  };

  if (input.policy) {
    snapshot.backgroundPolicy = {
      mode: input.policy.mode,
      maxConcurrentAgents: input.policy.maxConcurrentAgents,
      maxBackgroundCost: input.policy.maxBackgroundCost,
    };
  }

  if (input.devices) {
    const devices = Object.values(input.devices.devices);
    snapshot.devices = {
      paired: devices.filter((d) => !d.revoked).length,
      revoked: devices.filter((d) => d.revoked).length,
    };
  }

  if (input.events) {
    const coverage = ownershipCoverage(input.events.events);
    const byType: Record<string, number> = {};
    for (const event of input.events.events) {
      byType[event.type] = (byType[event.type] ?? 0) + 1;
    }
    const timestamps = input.events.events.map((e) => e.ts);
    snapshot.events = {
      total: input.events.events.length,
      byType,
      firstTs: timestamps.length ? Math.min(...timestamps) : undefined,
      lastTs: timestamps.length ? Math.max(...timestamps) : undefined,
      ownershipCoverage: coverage,
    };
  }

  return snapshot;
}

/**
 * Serialize a snapshot for sharing. Keys are sorted so exports are diffable.
 * The snapshot type only holds aggregates; this function exists to make that
 * guarantee explicit at the boundary and to keep the format stable.
 */
export function exportDiagnostics(snapshot: DiagnosticsSnapshot): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sorted(v)])
      );
    }
    return value;
  };
  return JSON.stringify(sorted(snapshot), null, 2);
}

/** Ownership keys covered by diagnostics via the event stream. */
export const DIAGNOSTICS_OWNERSHIP_KEYS: readonly OwnershipKey[] = OWNERSHIP_KEYS;
