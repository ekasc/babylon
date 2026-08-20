// Hook System for Phase 5.
//
// A small, stable Babylon hook lifecycle: pre_tool_use, post_tool_use,
// before_stop, attention_required. Hooks must have strict timeouts and must
// not deadlock the agent runtime. The registry is pure and testable; the
// dispatcher and enforcement build on top.

export type HookEvent = "pre_tool_use" | "post_tool_use" | "before_stop" | "attention_required";

export type HookAction =
  | "block"
  | "require_approval"
  | "rewrite_args"
  | "attach_metadata"
  | "notify";

export interface HookDefinition {
  id: string;
  event: HookEvent;
  enabled: boolean;
  /** Strict timeout so a hook cannot deadlock the agent runtime. */
  timeoutMs?: number;
  /** What the hook does (interpretation is up to the dispatcher). */
  action?: HookAction;
}

export interface HookRegistry {
  hooks: Record<string, HookDefinition>;
}

export function createHookRegistry(): HookRegistry {
  return { hooks: {} };
}

export function registerHook(registry: HookRegistry, hook: HookDefinition): HookRegistry {
  if (registry.hooks[hook.id]) return registry; // no clobber
  return { hooks: { ...registry.hooks, [hook.id]: hook } };
}

export function setHookEnabled(registry: HookRegistry, id: string, enabled: boolean): HookRegistry {
  const existing = registry.hooks[id];
  if (!existing || existing.enabled === enabled) return registry;
  return { hooks: { ...registry.hooks, [id]: { ...existing, enabled } } };
}

export function removeHook(registry: HookRegistry, id: string): HookRegistry {
  if (!registry.hooks[id]) return registry;
  const next = { ...registry.hooks };
  delete next[id];
  return { hooks: next };
}

/** Enabled hooks for an event, in registration order. */
export function listHooks(registry: HookRegistry, event: HookEvent): HookDefinition[] {
  return Object.values(registry.hooks).filter((h) => h.event === event && h.enabled);
}

export function listAllHooks(registry: HookRegistry): HookDefinition[] {
  return Object.values(registry.hooks);
}
