import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { rankCommandsEffect } from "./searchRanking.effect";

const commands = [
  { name: "review", description: "Review code", source: "prompt" as const },
  { name: "skill:review", description: "Review with a skill", source: "skill" as const },
  { name: "workflows", description: "Workflow controls", source: "extension" as const },
];

describe("searchRanking.effect", () => {
  it("ranks via Effect", async () => {
    const ranked = await Effect.runPromise(rankCommandsEffect(commands, "review"));
    expect(ranked.map((c) => c.name)).toEqual(["review", "skill:review"]);
  });

  it("empty query returns slice", async () => {
    const ranked = await Effect.runPromise(rankCommandsEffect(commands, ""));
    expect(ranked).toHaveLength(3);
  });
});
