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
import { createModelRolesState, type ModelRolesState, type RoleName } from "./model-roles";
import { createTaskRegistry, type TaskRegistry } from "./tasks";
import { isArrayOf, isPlainObject, isRecordOf, isString, wireOf } from "./lib/wire";

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

/** Every registry guard below verifies the shape it claims: a corrupt snapshot
 *  falls back to an empty registry instead of failing deep inside a caller.
 *  Enum membership (task status, attention type) is intentionally unchecked —
 *  classifiers degrade unknown values to idle, so a novel string is data, not
 *  corruption. Entry types derive from the registries via indexed access so
 *  the guards can't drift from the contracts. */
type TaskEntry = TaskRegistry["tasks"][string];
type AttentionEntry = AttentionRegistry["items"][string];
type HookEntry = HookRegistry["hooks"][string];
type RoleEntry = NonNullable<ModelRolesState["roles"][RoleName]>;
type ContractEntry = CompletionContract;

function isTaskEntry(v: unknown): v is TaskEntry {
  return isPlainObject(v) && typeof v.id === "string" && typeof v.title === "string" && typeof v.status === "string";
}
function isAttentionEntry(v: unknown): v is AttentionEntry {
  return (
    isPlainObject(v) &&
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.resolved === "boolean"
  );
}
function isHookEntry(v: unknown): v is HookEntry {
  return isPlainObject(v) && typeof v.id === "string" && typeof v.event === "string" && typeof v.enabled === "boolean";
}
function isRoleEntry(v: unknown): v is RoleEntry {
  // Role configs are all-optional: presence as an object is the whole claim.
  return isPlainObject(v);
}
function isContractEntry(v: unknown): v is ContractEntry {
  return (
    isPlainObject(v) &&
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    Array.isArray(v.checks)
  );
}
function validTasks(v: unknown): v is TaskRegistry {
  return isRecordOf(wireOf(v)?.["tasks"], isTaskEntry);
}
function validAttention(v: unknown): v is AttentionRegistry {
  return isRecordOf(wireOf(v)?.["items"], isAttentionEntry);
}
function validHooks(v: unknown): v is HookRegistry {
  const wire = wireOf(v);
  if (!wire) return false;
  if (!isArrayOf(wire["order"], isString)) return false;
  return isRecordOf(wire["hooks"], isHookEntry);
}
function validRoles(v: unknown): v is ModelRolesState {
  return isRecordOf(wireOf(v)?.["roles"], isRoleEntry);
}
function validContracts(v: unknown): v is Record<string, CompletionContract> {
  return isRecordOf(v, isContractEntry);
}

export function restoreRuntime(json: string): RuntimeState {
  const parsed: unknown = JSON.parse(json);
  if (!isPlainObject(parsed)) {
    throw new Error("Cannot restore runtime: input is not a runtime object");
  }
  const wire = parsed;
  if (wire["version"] !== RUNTIME_VERSION) {
    throw new Error(`Cannot restore runtime version ${String(wire["version"])}; expected ${RUNTIME_VERSION}`);
  }
  const base = createRuntime();
  // Build from an explicit allow-list so unknown/tampered keys cannot leak onto
  // the runtime, and validate each registry's shape so a corrupt snapshot is
  // rejected cleanly instead of failing deep inside a later caller.
  return {
    version: RUNTIME_VERSION,
    tasks: validTasks(wire["tasks"]) ? wire["tasks"] : base.tasks,
    attention: validAttention(wire["attention"]) ? wire["attention"] : base.attention,
    hooks: validHooks(wire["hooks"]) ? wire["hooks"] : base.hooks,
    roles: validRoles(wire["roles"]) ? wire["roles"] : base.roles,
    contracts: validContracts(wire["contracts"]) ? wire["contracts"] : base.contracts,
  };
}
