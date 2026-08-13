import { describe, expect, it } from "vitest";
import { initialState, messagesToItems, reducer } from "./store";

describe("subagent activity messages", () => {
  it("renders messages injected into the parent conversation", () => {
    expect(messagesToItems([{
      role: "custom",
      customType: "babylon_subagent_activity",
      content: "[Babylon Subagent Activity]\nThe user sent a steering message",
      display: true,
      timestamp: 1,
    }])).toEqual([{
      kind: "system",
      key: "c:1:0",
      text: "[Babylon Subagent Activity]\nThe user sent a steering message",
    }]);
  });
});

describe("optimistic image messages", () => {
  it("renders images immediately while the prompt is being accepted", () => {
    const state = reducer(initialState, {
      type: "local-user",
      text: "look at this",
      images: ["data:image/png;base64,abc"],
    });
    expect(state.items[0]).toMatchObject({
      kind: "user",
      text: "look at this",
      images: ["data:image/png;base64,abc"],
      imageCount: 1,
    });
  });
});
