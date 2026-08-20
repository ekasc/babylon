// Babylon Runtime authority for Phase 6 (Control Plane).
//
// The ROADMAP requires runtime state to remain authoritative *outside* React and
// to be persistent and reconnectable. This module is the single in-memory
// aggregate of the pure domain registries (tasks, attention, hooks, model
// roles, completion contracts). It is the natural boundary the daemon would
// own: React never mutates these structures directly, and the whole state can
// be snapshotted to JSON for persistence and restored on reconnect.

import type { AttentionRegistry } from "./attention";
import type { CompletionContract } from "./completion-contracts";
import { createAttentionRegistry } from "./attention";
import { createHookRegistry, type HookRegistry } from "./hooks";
import { createModelRolesState, type ModelRolesState } from "./model-roles";
import { createTaskRegistry, type TaskRegistry } from "./tasks";

export const RUNTIME_VERSION = 1;

export interface RuntimeState {
  version: number;
  tasks: TaskRegistry;
  attention: AttentionRegistry;
  hooks: HookRegistry;
  roles: ModelRolesState;
  contracts: Record<string, CompletionContract>;
}

export function createRuntime(): RuntimeState {
  return {
    version: RUNTIME_VERSION,
    tasks: createTaskRegistry(),
    attention: createAttentionRegistry(),
    hooks: createHookRegistry(),
    roles: createModelRolesState(),
    contracts: {},
  };
}

/** Mint a stable, collision-resistant id for a protocol entity. */
export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function snapshotRuntime(state: RuntimeState): string {
  if (state.version !== RUNTIME_VERSION) {
    throw new Error(`Cannot snapshot runtime version ${state.version}; expected ${RUNTIME_VERSION}`);
  }
  return JSON.stringify(state);
}

export function restoreRuntime(json: string): RuntimeState {
  const parsed = JSON.parse(json) as Partial<RuntimeState>;
  if (parsed.version !== RUNTIME_VERSION) {
    throw new Error(`Cannot restore runtime version ${parsed.version}; expected ${RUNTIME_VERSION}`);
  }
  const base = createRuntime();
  return {
    ...base,
    ...parsed,
    tasks: parsed.tasks ?? base.tasks,
    attention: parsed.attention ?? base.attention,
    hooks: parsed.hooks ?? base.hooks,
    roles: parsed.roles ?? base.roles,
    contracts: parsed.contracts ?? base.contracts,
  };
}
