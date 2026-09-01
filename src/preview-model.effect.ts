import * as Effect from "effect/Effect";
import { createPreviewRegistry, detectServerFromCommand, listServers, type PreviewRegistry } from "./preview-model";

export const createPreviewRegistryEffect: Effect.Effect<PreviewRegistry> = Effect.sync(() =>
  createPreviewRegistry(),
);

export const listServersEffect = (registry: PreviewRegistry): Effect.Effect<ReturnType<typeof listServers>> =>
  Effect.sync(() => listServers(registry));

export const detectServerFromCommandEffect = (command: string): Effect.Effect<ReturnType<typeof detectServerFromCommand>> =>
  Effect.sync(() => detectServerFromCommand(command));
