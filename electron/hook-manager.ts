import { createHookRegistry, registerHook, removeHook, setHookEnabled, type HookDefinition, type HookRegistry } from "../src/hooks";
import { dispatchHooks, type HookContext, type HookResult } from "../src/hook-dispatcher";

export class HookManager {
  private registry: HookRegistry = createHookRegistry();
  private listeners = new Set<(registry: HookRegistry) => void>();

  subscribe(listener: (registry: HookRegistry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): HookDefinition[] {
    return Object.values(this.registry.hooks);
  }

  getRegistry(): HookRegistry {
    return this.registry;
  }

  register(hook: HookDefinition): HookRegistry {
    this.registry = registerHook(this.registry, hook);
    this.broadcast();
    return this.registry;
  }

  setEnabled(id: string, enabled: boolean): HookRegistry {
    this.registry = setHookEnabled(this.registry, id, enabled);
    this.broadcast();
    return this.registry;
  }

  remove(id: string): HookRegistry {
    this.registry = removeHook(this.registry, id);
    this.broadcast();
    return this.registry;
  }

  async dispatch(
    event: HookDefinition["event"],
    ctx: HookContext,
    exec: (def: HookDefinition, ctx: HookContext, signal: AbortSignal) => Promise<HookResult>
  ) {
    return dispatchHooks(this.registry, event, ctx, exec);
  }

  private broadcast(): void {
    for (const l of this.listeners) {
      try {
        l(this.registry);
      } catch {}
    }
  }
}
