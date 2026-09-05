import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { createTask, createTaskRegistry } from "./tasks";
import { allocateTerminalEffect } from "./tasks.effect";

describe("tasks.effect", () => {
  it("allocates via Effect", async () => {
    const t = createTask({ id: "t1", title: "Test" });
    let r = createTaskRegistry();
    r = (await import("./tasks")).addTask(r, t);
    const res = await Effect.runPromise(allocateTerminalEffect(r, "t1"));
    expect(res?.terminalId).toBe("term-1");
  });
});
