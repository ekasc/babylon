import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { dispatchHooksEffect } from "./hook-dispatcher.effect";
import { createHookRegistry } from "./hooks";

describe("hook-dispatcher.effect", () => {
  it("dispatches via Effect", async () => {
    const reg = createHookRegistry();
    const out = await Effect.runPromise(
      dispatchHooksEffect(reg, { type: "before_tool_use" } as any, { sessionId: "s1" }, async () => ({})),
    );
    expect(out.results).toEqual([]);
  });
});
