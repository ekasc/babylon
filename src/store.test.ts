import { describe, expect, it } from "vitest";
import { initialState, mergeLiveMessages, messagesToItems, reconcileItems, reducer } from "./store";

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

describe("live merge", () => {
  it("keeps the loaded transcript stable and appends only newer live messages", () => {
    const loaded = [
      { role: "user", content: "one", timestamp: 100 },
      { role: "assistant", content: "two", timestamp: 200 },
    ];
    const live = [
      { role: "compactionSummary", content: "summary", timestamp: 150 }, // not newer than last
      { role: "user", content: "three", timestamp: 300 },
      { role: "assistant", content: "four", timestamp: 400 },
    ];
    const merged = mergeLiveMessages(loaded, live);
    expect(merged.map((m) => m.content)).toEqual(["one", "two", "three", "four"]);
    // Identity is preserved: the same object reference for the kept prefix.
    expect(merged[0]).toBe(loaded[0]);
  });

  it("returns the loaded list untouched when the live view is not newer", () => {
    const loaded = [{ role: "user", content: "one", timestamp: 500 }];
    const merged = mergeLiveMessages(loaded, [{ role: "user", content: "older", timestamp: 100 }]);
    expect(merged).toBe(loaded);
  });
});

describe("tool reconciliation", () => {
  it("replaces a tool row when the middle of a large detail changes", () => {
    const previous: any = { kind: "tool", key: "t:1", toolCallId: "call", name: "read", status: "done", details: `head${"a".repeat(200)}tail` };
    const next: any = { ...previous, details: `head${"b".repeat(200)}tail` };
    expect(reconcileItems([previous], [next])[0]).toBe(next);
  });
});

describe("custom activity messages render live", () => {
  it("renders a thread milestone message_start as a system line", () => {
    const state = reducer(initialState, {
      type: "event",
      event: {
        type: "message_start",
        message: {
          role: "custom",
          customType: "babylon_thread_activity",
          content: "[Babylon Thread Activity]\nThread worker reached a milestone — plan drafted",
          display: true,
        },
      },
    });
    expect(state.items).toEqual([
      { kind: "system", key: expect.stringContaining("c"), text: "[Babylon Thread Activity]\nThread worker reached a milestone — plan drafted" },
    ]);
  });
});
