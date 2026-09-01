import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { createScheduledTaskRegistryEffect, listDueTasksEffect } from "./automation.effect";

describe("automation.effect", () => {
  it("creates and lists via Effect", async () => {
    const reg = await Effect.runPromise(createScheduledTaskRegistryEffect);
    const due = await Effect.runPromise(listDueTasksEffect(reg, Date.now()));
    expect(due).toEqual([]);
  });
});
