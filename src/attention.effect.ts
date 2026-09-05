import * as Effect from "effect/Effect";
import { addAttention, createAttentionRegistry, removeAttention, resolveAttention, type AttentionItem, type AttentionRegistry } from "./attention";

export const createAttentionRegistryEffect: Effect.Effect<AttentionRegistry> = Effect.sync(() =>
  createAttentionRegistry(),
);

export const addAttentionEffect = (
  registry: AttentionRegistry,
  item: AttentionItem,
): Effect.Effect<AttentionRegistry> => Effect.sync(() => addAttention(registry, item));

export const resolveAttentionEffect = (registry: AttentionRegistry, id: string): Effect.Effect<AttentionRegistry> =>
  Effect.sync(() => resolveAttention(registry, id));

export const removeAttentionEffect = (registry: AttentionRegistry, id: string): Effect.Effect<AttentionRegistry> =>
  Effect.sync(() => removeAttention(registry, id));
