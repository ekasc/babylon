import { describe, expect, it } from "vitest";
import type { ChatItem } from "../store";
import { buildTurnFolds } from "./chat-folds";

const user = (key: string): ChatItem => ({ kind: "user", key, text: "prompt" });
const assistant = (key: string, text = "answer"): ChatItem => ({
  kind: "assistant",
  key,
  blocks: [{ type: "text", text }],
  model: "m",
});
const tool = (key: string, name = "bash"): ChatItem => ({
  kind: "tool",
  key,
  toolCallId: key,
  name,
  args: {},
  status: "done",
});

const folds = (
  shown: ChatItem[],
  userIndices: number[],
  hasCard: (i: number) => boolean = () => false,
) => buildTurnFolds(shown, userIndices, hasCard);

describe("buildTurnFolds", () => {
  it("folds a turn that hides only a single tool call", () => {
    const shown = [user("u1"), tool("t1"), assistant("a1")];
    const map = folds(shown, [0]);
    expect(map.get(0)).toMatchObject({ hiddenCount: 1, label: "1 command" });
  });

  it("folds a tool-less turn whose only work is an intermediate assistant step", () => {
    const shown = [user("u1"), assistant("a-inter", "thinking"), assistant("a-final")];
    expect(folds(shown, [0]).get(0)).toMatchObject({ hiddenCount: 1, label: "Reasoning" });
  });

  it("keeps the terminal answer visible (not counted as hidden)", () => {
    const shown = [user("u1"), tool("t1"), assistant("a-inter"), tool("t2"), assistant("a-final")];
    expect(folds(shown, [0]).get(0)?.hiddenCount).toBe(3);
  });

  it("folds a reasoning-only turn so its trace stays hidden until expanded", () => {
    const reasoned: ChatItem = {
      kind: "assistant",
      key: "a1",
      blocks: [
        { type: "thinking", text: "weighing options" },
        { type: "text", text: "answer" },
      ],
      model: "m",
    };
    const map = folds([user("u1"), reasoned], [0]);
    expect(map.get(0)).toMatchObject({ hiddenCount: 0, label: "Reasoning", terminalIdx: 1 });
  });

  it("does not fold a turn with nothing to hide", () => {
    expect(folds([user("u1"), assistant("a1")], [0]).size).toBe(0);
  });

  it("folds the live turn too — nothing is expanded while the agent runs", () => {
    const map = folds([user("u1"), tool("t1"), assistant("a1")], [0]);
    expect(map.get(0)?.hiddenCount).toBe(1);
  });

  it("folds every completed turn", () => {
    const shown = [user("u1"), tool("t1"), assistant("a1"), user("u2"), tool("t2"), assistant("a2")];
    const map = folds(shown, [0, 3]);
    expect([...map.keys()]).toEqual([0, 3]);
    expect(map.get(0)?.hiddenCount).toBe(1);
    expect(map.get(3)?.hiddenCount).toBe(1);
  });

  it("never hides an index that renders its own card", () => {
    const shown = [user("u1"), tool("t1"), assistant("a1")];
    expect(folds(shown, [0], (i) => i === 1).size).toBe(0);
  });
});
