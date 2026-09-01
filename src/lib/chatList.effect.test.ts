import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { resolveChatListAnchoredEndSpaceEffect } from "./chatList.effect";

describe("chatList.effect", () => {
  it("resolves via Effect", async () => {
    const r = await Effect.runPromise(
      resolveChatListAnchoredEndSpaceEffect([{ id: "a" }], "a", (x: any) => x.id),
    );
    expect(r?.anchorIndex).toBe(0);
  });
});
