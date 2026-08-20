// Model Roles for Parallel Work.
//
// Generalizes Babylon's use of cheaper models for background work into explicit,
// optional roles. Each role configures provider/model, reasoning level, token
// budget, and a fallback. Roles are resolved by merging an override onto a base
// config so the primary session stays independent and background roles never
// silently consume expensive models. Pure and testable.

export type RoleName = "primary" | "planner" | "scout" | "reviewer" | "recap" | "title";

export interface ModelRoleConfig {
  provider?: string;
  model?: string;
  /** Reasoning/effort level understood by the provider. */
  reasoning?: string;
  tokenBudget?: number;
  fallbackModel?: string;
}

export interface ModelRolesState {
  /** Per-role overrides. A role absent here falls back to `base`. */
  roles: Partial<Record<RoleName, ModelRoleConfig>>;
}

export const ROLE_NAMES: RoleName[] = [
  "primary",
  "planner",
  "scout",
  "reviewer",
  "recap",
  "title",
];

export function createModelRolesState(): ModelRolesState {
  return { roles: {} };
}

/**
 * Shallow-merge an override onto a base config. The override wins, and an
 * explicit `undefined` in the override is ignored (so base values survive),
 * matching the "never undefined" contract.
 */
export function mergeRoleConfig(
  base: ModelRoleConfig | undefined,
  override: ModelRoleConfig | undefined
): ModelRoleConfig {
  const o = override ?? {};
  const cleaned = Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined)
  );
  return { ...base, ...cleaned };
}

/**
 * Set (or incrementally update) a role. The config is merged onto any existing
 * role config, so partial updates do not drop other fields. To clear a role,
 * use clearRole.
 */
export function setRole(
  state: ModelRolesState,
  name: RoleName,
  config: ModelRoleConfig
): ModelRolesState {
  return { roles: { ...state.roles, [name]: mergeRoleConfig(state.roles[name], config) } };
}

export function clearRole(state: ModelRolesState, name: RoleName): ModelRolesState {
  const next = { ...state.roles };
  delete next[name];
  return { roles: next };
}

/** Resolve a role's effective config by layering its override onto `base`. */
export function resolveRole(
  state: ModelRolesState,
  name: RoleName,
  base?: ModelRoleConfig
): ModelRoleConfig {
  return mergeRoleConfig(base, state.roles[name]);
}

export function listConfiguredRoles(state: ModelRolesState): RoleName[] {
  return ROLE_NAMES.filter((r) => state.roles[r] !== undefined);
}
