import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/daemon-client";
import type { PiHost } from "./pi-host";
import { resolveRuntime } from "./runtime-select";

function makeClient() {
  const requests: Array<{ type: string; payload: unknown }> = [];
  const client = {
    request: vi.fn(async (type: string, payload: unknown) => {
      requests.push({ type, payload });
      return { payload: { ok: true } };
    }),
    onEvent: vi.fn(() => () => {}),
  } as unknown as DaemonClient;
  return { client, requests };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    runtimeOwner: "local" as const,
    daemonClient: null as DaemonClient | null,
    host: null as PiHost | null,
    taskManager: {} as never,
    attentionManager: {} as never,
    hookManager: {} as never,
    contracts: new Map(),
    ...overrides,
  };
}

describe("resolveRuntime", () => {
  it("daemon-owned with a live client returns a daemon facade", async () => {
    const { client, requests } = makeClient();
    const runtime = resolveRuntime(baseDeps({ runtimeOwner: "daemon", daemonClient: client }));
    await runtime.warmProject("/tmp/project");
    expect(requests).toEqual([{ type: "pi.warmProject", payload: { cwd: "/tmp/project" } }]);
  });

  it("daemon-owned without a live client fails fast instead of returning a crippled local runtime", () => {
    expect(() => resolveRuntime(baseDeps({ runtimeOwner: "daemon", daemonClient: null }))).toThrow(
      /daemon is reconnecting/
    );
  });

  it("local with a host delegates to the host", async () => {
    const host = { warmProject: vi.fn(async () => ({ warmed: true })) } as unknown as PiHost;
    const runtime = resolveRuntime(baseDeps({ host }));
    await expect(runtime.warmProject("/tmp/project")).resolves.toEqual({ warmed: true });
    expect(host.warmProject).toHaveBeenCalledWith("/tmp/project");
  });

  it("local without a host keeps the early-startup stub for the session basics", async () => {
    const runtime = resolveRuntime(baseDeps({}));
    await expect(runtime.getMessages()).resolves.toEqual([]);
    await expect(runtime.getState()).resolves.toEqual({});
  });
});
