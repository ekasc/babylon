import { describe, expect, it, vi } from "vitest";
import { createHookRegistry, registerHook } from "./hooks";
import { dispatchHooks, type HookContext } from "./hook-dispatcher";

const ctx: HookContext = { toolName: "bash", sessionId: "s1" };

describe("hook dispatcher", () => {
  it("respects registration order and skips disabled", async () => {
    let r = createHookRegistry();
    r = registerHook(r, { id: "2", event: "pre_tool_use", enabled: true, timeoutMs: 1000 });
    r = registerHook(r, { id: "1", event: "pre_tool_use", enabled: true, timeoutMs: 1000 });
    r = registerHook(r, { id: "10", event: "pre_tool_use", enabled: false, timeoutMs: 1000 });
    const order: string[] = [];
    const out = await dispatchHooks(r, "pre_tool_use", ctx, async (def) => {
      order.push(def.id);
      return {};
    });
    expect(order).toEqual(["2", "1"]);
    expect(out.results.map((x) => x.id)).toEqual(["2", "1"]);
  });

  it("isolates timeout and continues to next hook", async () => {
    let r = createHookRegistry();
    r = registerHook(r, { id: "slow", event: "pre_tool_use", enabled: true, timeoutMs: 15 });
    r = registerHook(r, { id: "fast", event: "pre_tool_use", enabled: true, timeoutMs: 1000 });
    const out = await dispatchHooks(r, "pre_tool_use", ctx, async (def) => {
      if (def.id === "slow") await new Promise((res) => setTimeout(res, 100));
      return { metadata: { [def.id]: 1 } };
    });
    expect(out.errors.some((e) => e.id === "slow" && e.timedOut)).toBe(true);
    expect(out.results.map((x) => x.id)).toEqual(["fast"]);
    expect(out.collectedMetadata).toEqual({ fast: 1 });
  });

  it("isolates error and continues", async () => {
    let r = createHookRegistry();
    r = registerHook(r, { id: "bad", event: "pre_tool_use", enabled: true, timeoutMs: 1000 });
    r = registerHook(r, { id: "ok", event: "pre_tool_use", enabled: true, timeoutMs: 1000 });
    const out = await dispatchHooks(r, "pre_tool_use", ctx, async (def) => {
      if (def.id === "bad") throw new Error("boom");
      return {};
    });
    expect(out.errors[0]).toMatchObject({ id: "bad", error: "boom" });
    expect(out.results.map((x) => x.id)).toEqual(["ok"]);
  });

  it("first block short-circuits remaining hooks", async () => {
    let r = createHookRegistry();
    r = registerHook(r, { id: "a", event: "pre_tool_use", enabled: true, timeoutMs: 1000 });
    r = registerHook(r, { id: "b", event: "pre_tool_use", enabled: true, timeoutMs: 1000 });
    r = registerHook(r, { id: "c", event: "pre_tool_use", enabled: true, timeoutMs: 1000 });
    const seen: string[] = [];
    const out = await dispatchHooks(r, "pre_tool_use", ctx, async (def) => {
      seen.push(def.id);
      if (def.id === "b") return { block: { reason: "nope" } };
      return {};
    });
    expect(seen).toEqual(["a", "b"]);
    expect(out.blocked?.id).toBe("b");
    expect(out.results.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("threads rewriteArgs and collects metadata", async () => {
    let r = createHookRegistry();
    r = registerHook(r, { id: "r1", event: "pre_tool_use", enabled: true, timeoutMs: 1000 });
    r = registerHook(r, { id: "r2", event: "pre_tool_use", enabled: true, timeoutMs: 1000 });
    const out = await dispatchHooks(
      r,
      "pre_tool_use",
      { ...ctx, args: { cmd: "echo hi" } },
      async (def, c) => {
        if (def.id === "r1") return { rewriteArgs: { cmd: "echo bye" }, metadata: { a: 1 } };
        expect(c.args).toEqual({ cmd: "echo bye" });
        return { metadata: { b: 2 } };
      }
    );
    expect(out.rewrittenArgs).toEqual({ cmd: "echo bye" });
    expect(out.collectedMetadata).toEqual({ a: 1, b: 2 });
  });

  it("leaves no pending timers after a successful dispatch", async () => {
    vi.useFakeTimers();
    try {
      let r = createHookRegistry();
      r = registerHook(r, { id: "a", event: "pre_tool_use", enabled: true, timeoutMs: 1000 });
      r = registerHook(r, { id: "b", event: "pre_tool_use", enabled: true, timeoutMs: 1000 });
      const pending = dispatchHooks(r, "pre_tool_use", ctx, async (def) => ({
        metadata: { [def.id]: 1 },
      }));
      await vi.advanceTimersByTimeAsync(0);
      const out = await pending;
      expect(out.results).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timeout timer when a hook times out", async () => {
    vi.useFakeTimers();
    try {
      let r = createHookRegistry();
      r = registerHook(r, { id: "slow", event: "pre_tool_use", enabled: true, timeoutMs: 15 });
      const pending = dispatchHooks(r, "pre_tool_use", ctx, async () => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(20);
      const out = await pending;
      expect(out.errors.some((e) => e.id === "slow" && e.timedOut)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
