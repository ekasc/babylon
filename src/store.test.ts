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

describe("CLI-invisible activity records", () => {
  // New writes use display:false so pi's TUI (which renders custom messages
  // iff display is true) stays clean; Babylon matches by customType so both
  // old (true) and new (false) files render identically here.
  for (const display of [true, false]) {
    it(`renders display:${display} bot relays and activity as system lines`, () => {
      expect(messagesToItems([
        { role: "custom", customType: "babylon_bot_message", content: "@a replied", display, timestamp: 1 },
        { role: "custom", customType: "babylon_thread_activity", content: "Thread x done.", display, timestamp: 2 },
      ]).map((i) => (i.kind === "system" ? i.text : i.kind))).toEqual(["@a replied", "Thread x done."]);
    });
  }

  it("renders display:false bot relays live", () => {
    const state = reducer(initialState, {
      type: "event",
      event: { type: "message_start", message: { role: "custom", customType: "babylon_bot_message", content: "hello", display: false } },
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "system", text: "hello" });
  });

  it("keeps swallowing display:false activity pings live (launch card owns them)", () => {
    const state = reducer(initialState, {
      type: "event",
      event: { type: "message_start", message: { role: "custom", customType: "babylon_subagent_activity", content: "x", display: false } },
    });
    expect(state.items).toHaveLength(0);
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
  it("routes thread activity to the launch card instead of a stray system line", () => {
    // No launch card exists yet for this run, so the live ping is a no-op;
    // it is surfaced via babylon_launch_update once the card is created.
    const state = reducer(initialState, {
      type: "event",
      event: {
        type: "message_start",
        message: {
          role: "custom",
          customType: "babylon_thread_activity",
          content: "[Babylon Thread Activity]\nThread worker reached a milestone, plan drafted",
          display: true,
        },
      },
    });
    expect(state.items).toEqual([]);
  });
});

describe("launch card live updates", () => {
  it("creates a card on start and keeps it live via babylon_launch_update", () => {
    let state = reducer(initialState, {
      type: "event",
      event: { type: "babylon_launch_started", runId: "abc123", runKind: "thread", label: "worker", status: "running", sessionId: "s1" },
    });
    const card = state.items.find((i) => i.kind === "launch") as any;
    expect(card).toMatchObject({ kind: "launch", runId: "abc123", runKind: "thread", status: "running" });

    state = reducer(state, {
      type: "event",
      event: { type: "babylon_launch_update", runId: "abc123", runKind: "thread", log: "reached a milestone, plan drafted", sessionId: "s1" },
    });
    expect((state.items.find((i) => i.kind === "launch") as any).log).toBe("reached a milestone, plan drafted");

    state = reducer(state, {
      type: "event",
      event: { type: "babylon_launch_update", runId: "abc123", runKind: "thread", status: "completed", sessionId: "s1" },
    });
    const done = state.items.find((i) => i.kind === "launch") as any;
    expect(done.status).toBe("completed");
    expect(done.log).toBe("reached a milestone, plan drafted");
  });

  it("ignores updates for an unknown run", () => {
    const state = reducer(initialState, {
      type: "event",
      event: { type: "babylon_launch_update", runId: "missing", runKind: "subagent", log: "hi", sessionId: "s1" },
    });
    expect(state.items).toEqual([]);
  });
});

describe("group room transcript collapsing", () => {
  const director = (handle: string) => ({
    role: "user",
    content: `[Room turn] @${handle}, respond briefly in your voice to the room above (or reply exactly PASS if you have nothing new).`,
  });
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

  it("hides director prompts and drops PASS replies entirely", () => {
    const items = messagesToItems([
      { role: "user", content: "yo" },
      assistant("yo, what's up?"),
      director("check"),
      assistant("PASS"),
      director("brain"),
      assistant("@brain, standing by."),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "assistant"]);
    expect((items[2] as any).blocks[0].text).toContain("standing by");
  });

  it("keeps assistant turns with tools even after a director", () => {
    const items = messagesToItems([
      director("brain"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "PASS" },
          { type: "toolCall", id: "c1", name: "read", arguments: "{}" },
        ],
      },
    ]);
    expect(items.some((i) => i.kind === "assistant")).toBe(true);
    expect(items.some((i) => i.kind === "tool")).toBe(true);
  });

  it("suppresses live director user bubbles", () => {
    const state = reducer(initialState, {
      type: "event",
      event: { type: "message_start", message: { role: "user", content: "[Room turn] @brain, go" } },
    });
    expect(state.items).toEqual([]);
  });

  it("tracks room turn presence and clears it on reply, settle, and rebuild", () => {
    let state = reducer(initialState, {
      type: "event",
      event: { type: "babylon_room_turn", handle: "brain", phase: "started" },
    });
    expect(state.roomTurn).toEqual({ handle: "brain", phase: "started" });
    state = reducer(state, {
      type: "event",
      event: { type: "babylon_room_turn", handle: "brain", phase: "passed" },
    });
    expect(state.roomTurn).toBeNull();
    state = reducer(initialState, {
      type: "event",
      event: { type: "babylon_room_turn", handle: "brain", phase: "started" },
    });
    state = reducer(state, { type: "event", event: { type: "agent_settled" } });
    expect(state.roomTurn).toBeNull();
  });
});

describe("group room speaker attribution", () => {
  it("tags spoke turns with the directed handle", () => {
    const items = messagesToItems([
      {
        role: "user",
        content: "[Room turn] @brain, respond briefly in your voice to the room above (or reply exactly PASS if you have nothing new).",
      },
      { role: "assistant", content: [{ type: "text", text: "@brain, standing by." }] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", speaker: "brain" });
  });
});
