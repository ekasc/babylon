/**
 * Runtime health binding. Health says "can Babylon talk to Pi?" and nothing
 * else: this hook's entire surface is a status value and an error. It has no
 * session, no cwd, and no navigation callback, so a health update cannot
 * select or prepare a conversation (C4/C6).
 */
import { useEffect, useState } from "react";
import type { RuntimeStatus } from "../bridge";
import { applyRuntimeStatus } from "./app-orchestration";

export interface RuntimeHealthDeps {
  /** Subscribe to health updates (bridge.onRuntimeStatus). */
  subscribe: (cb: (status: RuntimeStatus) => void) => () => void;
  /** Optional connection-derived health (daemon mode). */
  subscribeConnection?: (cb: (connected: boolean) => void) => () => void;
  onError?: (message: string) => void;
}

export function useRuntimeHealth(deps: RuntimeHealthDeps): RuntimeStatus {
  const [status, setStatus] = useState<RuntimeStatus>({ status: "starting" });

  // Depend on the STABLE callbacks, not on the deps object: App builds a fresh
  // object every render, and re-subscribing on identity churn would drop and
  // re-add the health listener on every single render.
  const { subscribe, subscribeConnection, onError } = deps;
  useEffect(() => {
    const off = subscribe((next) => {
      // Normalized through the same policy the tests pin: health is rebuilt
      // field by field, so nothing smuggled in can become view state.
      const outcome = applyRuntimeStatus(status, next);
      setStatus(outcome.status);
      if (outcome.errorMessage) onError?.(outcome.errorMessage);
    });
    return off;
  }, [subscribe, onError]);

  useEffect(() => {
    if (!subscribeConnection) return;
    return subscribeConnection((connected) => {
      setStatus((prev) =>
        connected ? { status: "ready" } : prev.status === "error" ? prev : { status: "starting" }
      );
    });
  }, [subscribeConnection]);

  return status;
}
