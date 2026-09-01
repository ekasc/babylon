import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { rankCommandsEffect } from "./commands.effect";

const commands = [
  { name: "review", description: "Review code", source: "prompt" as const },
  { name: "skill:review", description: "Review with a skill", source: "skill" as const },
];

describe("commands.effect", () => {
  it("ranks via Effect", async () => {
    const r = await Effect.runPromise(rankCommandsEffect(commands, "review"));
    expect(r.map((c) => c.name)).toEqual(["review", "skill:review"]);
  });
});
