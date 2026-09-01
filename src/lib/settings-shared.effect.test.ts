import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { getDefaultChatModelEffect } from "./settings-shared.effect";

describe("settings-shared.effect", () => {
  it("gets default via Effect", async () => {
    const m = await Effect.runPromise(getDefaultChatModelEffect());
    expect(m.provider).toBe("opencode-go");
  });
});
