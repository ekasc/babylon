import { describe, expect, it } from "vitest";
import { initialState, reducer } from "./store";

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
