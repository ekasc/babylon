import { listHooks, type HookDefinition, type HookEvent, type HookRegistry } from "./hooks";

export interface HookContext {
  toolName?: string;
  args?: unknown;
  taskId?: string;
  sessionId: string;
}

export interface HookResult {
  block?: { reason: string };
  rewriteArgs?: unknown;
  metadata?: Record<string, unknown>;
  notify?: string;
}

export interface HookDispatchError {
  id: string;
  error: string;
  timedOut?: boolean;
}

export interface HookDispatchOutcome {
  results: Array<{ id: string; result: HookResult }>;
  errors: HookDispatchError[];
  blocked?: { id: string; result: HookResult };
  rewrittenArgs?: unknown;
  collectedMetadata: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 5000;

function timeoutError(id: string, ms: number): HookDispatchError {
  return { id, error: `hook ${id} timed out after ${ms}ms`, timedOut: true };
}

export async function dispatchHooks(
  registry: HookRegistry,
  event: HookEvent,
  ctx: HookContext,
  exec: (def: HookDefinition, ctx: HookContext, signal: AbortSignal) => Promise<HookResult>
): Promise<HookDispatchOutcome> {
  const hooks = listHooks(registry, event);
  const results: Array<{ id: string; result: HookResult }> = [];
  const errors: HookDispatchError[] = [];
  let blocked: { id: string; result: HookResult } | undefined;
  let rewrittenArgs = ctx.args;
  let currentCtx = { ...ctx };
  const collectedMetadata: Record<string, unknown> = {};

  for (const def of hooks) {
    if (blocked) break;
    const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const execPromise = (async () => {
      const res = await exec(def, { ...currentCtx, args: rewrittenArgs }, controller.signal);
      return res ?? {};
    })();

    let result: HookResult | undefined;
    let error: Error | undefined;
    try {
      result = await Promise.race([
        execPromise,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`timeout:${timeoutMs}`));
          }, timeoutMs);
          timeout = timer;
        }),
      ]);
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }

    if (error) {
      if (error.message.startsWith("timeout:")) {
        errors.push(timeoutError(def.id, timeoutMs));
      } else {
        errors.push({ id: def.id, error: error.message });
      }
      continue;
    }

    const r = result ?? {};
    results.push({ id: def.id, result: r });

    if (r.rewriteArgs !== undefined) {
      rewrittenArgs = r.rewriteArgs;
      currentCtx = { ...currentCtx, args: rewrittenArgs };
    }
    if (r.metadata) {
      Object.assign(collectedMetadata, r.metadata);
    }
    if (r.block) {
      blocked = { id: def.id, result: r };
      break;
    }
  }

  return {
    results,
    errors,
    blocked,
    rewrittenArgs: rewrittenArgs !== ctx.args ? rewrittenArgs : undefined,
    collectedMetadata,
  };
}
