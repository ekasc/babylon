import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { loadThemePrefEffect } from "./theme.effect";

describe("theme.effect", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    } as any);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) } as any);
    vi.stubGlobal("document", { documentElement: { classList: { toggle: () => {} }, style: {} } } as any);
  });
  it("loads via Effect", async () => {
    const v = await Effect.runPromise(loadThemePrefEffect);
    expect(["light", "dark", "system"]).toContain(v);
  });
});
