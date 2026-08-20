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
  /** Insertion order of hook ids, so listing is stable regardless of id shape. */
  order: string[];
}

function validateHook(hook: HookDefinition): void {
  if (hook.timeoutMs != null && hook.timeoutMs <= 0) {
    throw new Error(`Hook ${hook.id} has an invalid timeoutMs (${hook.timeoutMs}); it must be positive`);
  }
}

export function createHookRegistry(): HookRegistry {
  return { hooks: {}, order: [] };
}

export function registerHook(registry: HookRegistry, hook: HookDefinition): HookRegistry {
  if (registry.hooks[hook.id]) return registry; // no clobber
  validateHook(hook);
  // Store a copy so a later mutation of the caller's object does not change the
  // registry's state (the registry is meant to be immutable per-mutation).
  return {
    hooks: { ...registry.hooks, [hook.id]: { ...hook } },
    order: [...registry.order, hook.id],
  };
}

export function setHookEnabled(registry: HookRegistry, id: string, enabled: boolean): HookRegistry {
  const existing = registry.hooks[id];
  if (!existing || existing.enabled === enabled) return registry;
  return { ...registry, hooks: { ...registry.hooks, [id]: { ...existing, enabled } } };
}

export function removeHook(registry: HookRegistry, id: string): HookRegistry {
  if (!registry.hooks[id]) return registry;
  const hooks = { ...registry.hooks };
  delete hooks[id];
  return { hooks, order: registry.order.filter((o) => o !== id) };
}

/** Enabled hooks for an event, in registration order. */
export function listHooks(registry: HookRegistry, event: HookEvent): HookDefinition[] {
  return registry.order
    .map((id) => registry.hooks[id])
    .filter((h) => h.event === event && h.enabled);
}

export function listAllHooks(registry: HookRegistry): HookDefinition[] {
  return registry.order.map((id) => registry.hooks[id]);
}
