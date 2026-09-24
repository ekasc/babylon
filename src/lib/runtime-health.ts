/**
 * Runtime health binding. Health says "can Babylon talk to Pi?" and nothing
 * else: this hook's entire surface is a status value and an error. It has no
 * session, no cwd, and no navigation callback, so a health update cannot
 * select or prepare a conversation (C4/C6).
 */
import { useEffect, useState } from "react";
import type { RuntimeStatus } from "../bridge";

export interface RuntimeHealthDeps {
  /** Subscribe to health updates (bridge.onRuntimeStatus). */
  subscribe: (cb: (status: RuntimeStatus) => void) => () => void;
  /** Optional connection-derived health (daemon mode). */
  subscribeConnection?: (cb: (connected: boolean) => void) => () => void;
  onError?: (message: string) => void;
}

export function useRuntimeHealth(deps: RuntimeHealthDeps): RuntimeStatus {
  const [status, setStatus] = useState<RuntimeStatus>({ status: "starting" });

  useEffect(() => {
    const off = deps.subscribe((next) => {
      setStatus(next);
      if (next.status === "error" && next.message) deps.onError?.(next.message);
    });
    return off;
  }, [deps]);

  useEffect(() => {
    if (!deps.subscribeConnection) return;
    return deps.subscribeConnection((connected) => {
      setStatus((prev) =>
        connected ? { status: "ready" } : prev.status === "error" ? prev : { status: "starting" }
      );
    });
  }, [deps]);

  return status;
}
