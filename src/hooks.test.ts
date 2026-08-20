import { describe, expect, it } from "vitest";
import {
  createHookRegistry,
  listAllHooks,
  listHooks,
  registerHook,
  removeHook,
  setHookEnabled,
  type HookDefinition,
  type HookRegistry,
} from "./hooks";

function hook(over: Partial<HookDefinition> = {}): HookDefinition {
  return { id: "h1", event: "pre_tool_use", enabled: true, action: "block", timeoutMs: 2000, ...over };
}

describe("hook system", () => {
  it("registers a hook and refuses to overwrite", () => {
    let r: HookRegistry = createHookRegistry();
    r = registerHook(r, hook());
    expect(r.hooks.h1.event).toBe("pre_tool_use");
    r = registerHook(r, hook({ event: "post_tool_use" }));
    expect(r.hooks.h1.event).toBe("pre_tool_use");
  });

  it("enables and disables without churn", () => {
    let r = registerHook(createHookRegistry(), hook({ enabled: false }));
    r = setHookEnabled(r, "h1", true);
    expect(r.hooks.h1.enabled).toBe(true);
    expect(setHookEnabled(r, "h1", true)).toBe(r); // no-op
    expect(setHookEnabled(r, "missing", true)).toBe(r); // no-op returns same ref
  });

  it("removes a hook (no-op when absent)", () => {
    const r = registerHook(createHookRegistry(), hook());
    const removed = removeHook(r, "h1");
    expect(removed.hooks.h1).toBeUndefined();
    expect(removeHook(removed, "h1")).toBe(removed);
  });

  it("lists enabled hooks for an event", () => {
    let r = createHookRegistry();
    r = registerHook(r, hook({ id: "a", event: "pre_tool_use" }));
    r = registerHook(r, hook({ id: "b", event: "pre_tool_use", enabled: false }));
    r = registerHook(r, hook({ id: "c", event: "post_tool_use" }));
    expect(listHooks(r, "pre_tool_use").map((h) => h.id)).toEqual(["a"]);
    expect(listAllHooks(r)).toHaveLength(3);
  });

  it("preserves registration order regardless of id shape", () => {
    let r = createHookRegistry();
    r = registerHook(r, hook({ id: "2", event: "post_tool_use" }));
    r = registerHook(r, hook({ id: "1", event: "post_tool_use" }));
    r = registerHook(r, hook({ id: "10", event: "post_tool_use" }));
    expect(listHooks(r, "post_tool_use").map((h) => h.id)).toEqual(["2", "1", "10"]);
  });

  it("rejects a non-positive timeoutMs", () => {
    expect(() => registerHook(createHookRegistry(), hook({ timeoutMs: 0 }))).toThrow();
    expect(() => registerHook(createHookRegistry(), hook({ timeoutMs: -1 }))).toThrow();
  });
});
