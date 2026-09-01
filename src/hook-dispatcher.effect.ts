import * as Effect from "effect/Effect";
import { dispatchHooks, type HookContext, type HookDispatchOutcome, type HookResult } from "./hook-dispatcher";
import type { HookDefinition, HookEvent, HookRegistry } from "./hooks";

export const dispatchHooksEffect = (
  registry: HookRegistry,
  event: HookEvent,
  ctx: HookContext,
  exec: (def: HookDefinition, ctx: HookContext, signal: AbortSignal) => Promise<HookResult>,
): Effect.Effect<HookDispatchOutcome> => Effect.promise(() => dispatchHooks(registry, event, ctx, exec));
