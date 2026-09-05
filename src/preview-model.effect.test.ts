import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { createPreviewRegistryEffect, detectServerFromCommandEffect } from "./preview-model.effect";

describe("preview-model.effect", () => {
  it("detects via Effect", async () => {
    expect(await Effect.runPromise(detectServerFromCommandEffect("pnpm dev"))).toEqual({ port: 5173, framework: "vite" });
    const reg = await Effect.runPromise(createPreviewRegistryEffect);
    expect(reg.servers).toEqual({});
  });
});
