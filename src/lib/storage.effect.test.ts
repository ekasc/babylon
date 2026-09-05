import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { getJsonWithFallbackEffect, getWithFallbackEffect, setItemEffect } from "./storage.effect";

function mockStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  } as any);
  return store;
}

describe("storage.effect", () => {
  beforeEach(() => mockStorage());
  it("wraps getWithFallback", async () => {
    localStorage.setItem("babylon:test-effect", "hello");
    const v = await Effect.runPromise(getWithFallbackEffect("test-effect"));
    expect(v).toBe("hello");
  });
  it("wraps getJson", async () => {
    localStorage.setItem("babylon:json-effect", JSON.stringify({ a: 1 }));
    const v = await Effect.runPromise(getJsonWithFallbackEffect("json-effect", { a: 0 }));
    expect(v).toEqual({ a: 1 });
  });
  it("setItemEffect", async () => {
    await Effect.runPromise(setItemEffect("set-effect", "x"));
    expect(localStorage.getItem("babylon:set-effect")).toBe("x");
  });
});
