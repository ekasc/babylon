import { addAttention, createAttentionRegistry, removeAttention, resolveAttention, type AttentionItem, type AttentionRegistry } from "../src/attention";

export class AttentionManager {
  private registry: AttentionRegistry = createAttentionRegistry();
  private listeners = new Set<(registry: AttentionRegistry) => void>();

  subscribe(listener: (registry: AttentionRegistry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): AttentionRegistry {
    return this.registry;
  }

  add(item: AttentionItem): AttentionRegistry {
    this.registry = addAttention(this.registry, item);
    this.broadcast();
    return this.registry;
  }

  resolve(id: string): AttentionRegistry {
    this.registry = resolveAttention(this.registry, id);
    this.broadcast();
    return this.registry;
  }

  remove(id: string): AttentionRegistry {
    this.registry = removeAttention(this.registry, id);
    this.broadcast();
    return this.registry;
  }

  private broadcast(): void {
    for (const l of this.listeners) {
      try {
        l(this.registry);
      } catch {}
    }
  }
}
