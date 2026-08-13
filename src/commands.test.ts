import { describe, expect, it } from "vitest";
import { commandTokenAtStart, insertCommand, rankCommands } from "./commands";

const commands = [
  { name: "review", description: "Review code", source: "prompt" as const },
  { name: "skill:review", description: "Review with a skill", source: "skill" as const },
  { name: "workflows", description: "Workflow controls", source: "extension" as const, argumentHint: "[action]" },
];

describe("slash command completion", () => {
  it("only completes the initial slash token", () => {
    expect(commandTokenAtStart("/ski")).toBe("ski");
    expect(commandTokenAtStart("hello /ski")).toBeNull();
    expect(commandTokenAtStart("/skill:review args")).toBeNull();
  });

  it("ranks exact and prefix matches before description matches", () => {
    expect(rankCommands(commands, "review").map((command) => command.name)).toEqual([
      "review",
      "skill:review",
    ]);
  });

  it("preserves an argument slot for commands that declare a hint", () => {
    expect(insertCommand(commands[2]!)).toBe("/workflows ");
    expect(insertCommand(commands[0]!)).toBe("/review");
  });
});
