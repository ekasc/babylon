/**
 * IPC identity validation for addressed mutators: a missing/empty sessionFile
 * is a protocol error at the renderer boundary — never a foreground fallback
 * (I7/I8). Validation must happen BEFORE the runtime is touched, proven by a
 * getRuntime spy that throws if reached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerRuntimeIpc } from "./runtime-ipc";
import { registerSessionRuntimeIpc } from "./session-runtime-ipc";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function captureHandlers(register: (handle: (channel: string, fn: Handler) => void) => void) {
  const handlers = new Map<string, Handler>();
  register((channel, fn) => handlers.set(channel, fn));
  return handlers;
}

const unreachableRuntime = vi.fn((..._args: unknown[]): unknown => {
  throw new Error("runtime must not be reached for invalid identity");
});

beforeEach(() => {
  // Shared spy: assert per-test, never across describes.
  vi.clearAllMocks();
});

describe("runtime-ipc addressed identity validation", () => {
  const handlers = captureHandlers((handle) =>
    registerRuntimeIpc(handle as unknown as Parameters<typeof registerRuntimeIpc>[0], {
      getRuntime: unreachableRuntime as unknown as Parameters<typeof registerRuntimeIpc>[1]["getRuntime"],
      daemonOnly: () => null,
      getWindow: (() => null) as unknown as Parameters<typeof registerRuntimeIpc>[1]["getWindow"],
      getHostReady: () => null,
    })
  );

  it("rejects empty sessionFile on set-model / set-thinking before touching the runtime", async () => {
    await expect(handlers.get("pideck:set-model")!(null, "", "prov", "id")).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:set-thinking")!(null, "", "high")).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:set-model")!(null, undefined, "prov", "id")).rejects.toThrow(/sessionFile is required/);
    expect(unreachableRuntime).not.toHaveBeenCalled();
  });

  it("rejects empty sessionFile on compact / rollback / fork / clone", async () => {
    await expect(handlers.get("pideck:compact")!(null, "")).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:rollback:prepare")!(null, "", "entry-1")).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:rollback:undo")!(null, "")).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:fork")!(null, "", "entry-1")).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:clone")!(null, "")).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:set-session-name")!(null, "", "New")).rejects.toThrow(/sessionFile is required/);
    expect(unreachableRuntime).not.toHaveBeenCalled();
  });

  it("addressed reads reject a missing sessionFile before touching the runtime", async () => {
    await expect(handlers.get("pideck:get-commands")!(null)).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:get-commands")!(null, "")).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:get-tree")!(null, "")).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:get-history")!(null, undefined)).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:get-thinking-levels")!(null, "")).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:get-fork-messages")!(null, "")).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:turn-changes")!(null, "", "e1")).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:get-models")!(null, "")).rejects.toThrow(/invalid project path/);
    expect(unreachableRuntime).not.toHaveBeenCalled();
  });
});

describe("project focus is an explicit, separate operation", () => {
  it("execution activation never changes the focused project", async () => {
    // C6/J: activation is execution-only. The UI's project focus is its own
    // operation, driven by activeSpace — never a side effect of a claim.
    const applyProjectFocus = vi.fn();
    const executionActivate = vi.fn(async () => ({
      ok: true as const,
      execution: {
        cwd: "/p",
        sessionFile: "/p/s.jsonl",
        sessionId: "s1",
        state: "idle" as const,
        streaming: false,
        generation: 1,
      },
    }));
    const handlers = captureHandlers((handle) =>
      registerSessionRuntimeIpc(handle as unknown as Parameters<typeof registerRuntimeIpc>[0], {
        sessionsRoot: "/tmp/never",
        getRuntime: (() => ({
          executionActivate,
          relocateExecution: async () => ({}),
        })) as unknown as Parameters<typeof registerSessionRuntimeIpc>[1]["getRuntime"],
        getHost: (() => null) as unknown as Parameters<typeof registerSessionRuntimeIpc>[1]["getHost"],
        isDaemonOwned: () => false,
        requireDaemonClient: (() => null) as unknown as Parameters<typeof registerSessionRuntimeIpc>[1]["requireDaemonClient"],
        driveSharedChatExtras: async () => undefined,
        applyProjectFocus,
      })
    );

    await handlers.get("pideck:execution-activate")!(null, { cwd: "/p" });
    expect(executionActivate).toHaveBeenCalledTimes(1);
    expect(applyProjectFocus).not.toHaveBeenCalled();

    // The renderer moves focus explicitly, and only that moves it.
    await handlers.get("pideck:project-focus")!(null, "/p");
    expect(applyProjectFocus).toHaveBeenCalledWith("/p");
  });
});

describe("session-runtime-ipc abort/getState identity", () => {
  const handlers = captureHandlers((handle) =>
    registerSessionRuntimeIpc(handle as unknown as Parameters<typeof registerRuntimeIpc>[0], {
      sessionsRoot: "/tmp/never",
      getRuntime: unreachableRuntime as unknown as Parameters<typeof registerRuntimeIpc>[1]["getRuntime"],
      getHost: (() => null) as unknown as Parameters<typeof registerSessionRuntimeIpc>[1]["getHost"],
      isDaemonOwned: () => false,
      requireDaemonClient: (() => null) as unknown as Parameters<typeof registerSessionRuntimeIpc>[1]["requireDaemonClient"],
      driveSharedChatExtras: async () => undefined,
    applyProjectFocus: () => undefined,
    })
  );

  it("abort requires a non-empty sessionFile (never undefined/null foreground fallback)", async () => {
    await expect(handlers.get("pideck:abort")!(null)).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:abort")!(null, {})).rejects.toThrow(/sessionFile is required/);
    await expect(handlers.get("pideck:abort")!(null, { sessionFile: "" })).rejects.toThrow(/sessionFile is required/);
    expect(unreachableRuntime).not.toHaveBeenCalled();
  });

  it("prompt and session-scoped reads reject a missing sessionFile", async () => {
    await expect(handlers.get("pideck:prompt")!(null, "hi")).rejects.toThrow(/session file/);
    await expect(handlers.get("pideck:prompt")!(null, "hi", undefined, undefined, null)).rejects.toThrow(/session file/);
    await expect(handlers.get("pideck:prompt")!(null, "hi", undefined, undefined, "")).rejects.toThrow(/session file/);
    await expect(handlers.get("pideck:get-messages")!(null)).rejects.toThrow(/invalid session file/);
    await expect(handlers.get("pideck:get-messages")!(null, "")).rejects.toThrow(/invalid session file/);
    await expect(handlers.get("pideck:get-stats")!(null, "")).rejects.toThrow(/invalid session file/);
    expect(unreachableRuntime).not.toHaveBeenCalled();
  });

  it("getState requires an addressed sessionFile (never a foreground fallback)", async () => {
    await expect(handlers.get("pideck:get-state")!(null, { sessionFile: "" })).rejects.toThrow(/get-state requires/);
    await expect(handlers.get("pideck:get-state")!(null, {})).rejects.toThrow(/get-state requires/);
    await expect(handlers.get("pideck:get-state")!(null)).rejects.toThrow(/get-state requires/);
    expect(unreachableRuntime).not.toHaveBeenCalled();
    unreachableRuntime.mockImplementationOnce(() => ({ getState: async () => ({ ok: true }) }));
    await expect(handlers.get("pideck:get-state")!(null, { sessionFile: "/tmp/s.jsonl" })).resolves.toEqual({ ok: true });
    expect(unreachableRuntime).toHaveBeenCalledTimes(1);
  });
});
