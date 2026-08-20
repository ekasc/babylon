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

/**
 * Mint a stable id for a protocol entity. Uniqueness within a running runtime is
 * guaranteed by a timestamp plus a monotonic counter plus random bytes; it is
 * not a global unique identifier across processes, but it is stable and safe to
 * use as a protocol key inside one Babylon instance.
 */
let idCounter = 0;
export function makeId(prefix: string): string {
  const rand =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 12);
  return `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}-${rand}`;
}

export function snapshotRuntime(state: RuntimeState): string {
  if (state.version !== RUNTIME_VERSION) {
    throw new Error(`Cannot snapshot runtime version ${state.version}; expected ${RUNTIME_VERSION}`);
  }
  return JSON.stringify(state);
}

function validTasks(v: unknown): v is TaskRegistry {
  return !!v && typeof v === "object" && (v as TaskRegistry).tasks != null && typeof (v as TaskRegistry).tasks === "object";
}
function validAttention(v: unknown): v is AttentionRegistry {
  return !!v && typeof v === "object" && (v as AttentionRegistry).items != null && typeof (v as AttentionRegistry).items === "object";
}
function validHooks(v: unknown): v is HookRegistry {
  return (
    !!v &&
    typeof v === "object" &&
    (v as HookRegistry).hooks != null &&
    Array.isArray((v as HookRegistry).order)
  );
}
function validRoles(v: unknown): v is ModelRolesState {
  return !!v && typeof v === "object" && (v as ModelRolesState).roles != null && typeof (v as ModelRolesState).roles === "object";
}
function validContracts(v: unknown): v is Record<string, CompletionContract> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function restoreRuntime(json: string): RuntimeState {
  const parsed = JSON.parse(json) as Partial<RuntimeState>;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Cannot restore runtime: input is not a runtime object");
  }
  if (parsed.version !== RUNTIME_VERSION) {
    throw new Error(`Cannot restore runtime version ${parsed.version}; expected ${RUNTIME_VERSION}`);
  }
  const base = createRuntime();
  // Build from an explicit allow-list so unknown/tampered keys cannot leak onto
  // the runtime, and validate each registry's shape so a corrupt snapshot is
  // rejected cleanly instead of failing deep inside a later caller.
  return {
    version: RUNTIME_VERSION,
    tasks: validTasks(parsed.tasks) ? parsed.tasks : base.tasks,
    attention: validAttention(parsed.attention) ? parsed.attention : base.attention,
    hooks: validHooks(parsed.hooks) ? parsed.hooks : base.hooks,
    roles: validRoles(parsed.roles) ? parsed.roles : base.roles,
    contracts: validContracts(parsed.contracts) ? parsed.contracts : base.contracts,
  };
}
