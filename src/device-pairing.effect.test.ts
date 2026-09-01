import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { createDeviceRegistryEffect } from "./device-pairing.effect";

describe("device-pairing.effect", () => {
  it("creates via Effect", async () => {
    const r = await Effect.runPromise(createDeviceRegistryEffect);
    expect(r.devices ?? r).toBeDefined();
  });
});
