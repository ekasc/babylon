import * as Effect from "effect/Effect";
import {
  createProcess,
  createRegistry,
  detectPorts,
  listActive,
  removeProcess,
  terminateProcess,
  updateProcess,
  type ProcessRegistry,
  type TrackedProcess,
} from "./process-model";

export const createRegistryEffect: Effect.Effect<ProcessRegistry> = Effect.sync(() => createRegistry());

export const createProcessEffect = (
  registry: ProcessRegistry,
  params: Parameters<typeof createProcess>[1],
): Effect.Effect<ProcessRegistry> => Effect.sync(() => createProcess(registry, params));

export const updateProcessEffect = (
  registry: ProcessRegistry,
  id: string,
  patch: Parameters<typeof updateProcess>[2],
): Effect.Effect<ProcessRegistry> => Effect.sync(() => updateProcess(registry, id, patch));

export const listActiveEffect = (registry: ProcessRegistry): Effect.Effect<TrackedProcess[]> =>
  Effect.sync(() => listActive(registry));
