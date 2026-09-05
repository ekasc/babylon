import { describe, expect, it } from "vitest";
import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from "./chatList";

describe("resolveChatListAnchoredEndSpace", () => {
  it("returns undefined for null anchor", () => {
    expect(resolveChatListAnchoredEndSpace([{ id: "a" }], null, (x) => x.id)).toBeUndefined();
  });

  it("returns anchor when found at start", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(resolveChatListAnchoredEndSpace(items, "a", (x) => x.id)).toEqual({
      anchorIndex: 0,
      anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
    });
  });

  it("returns undefined when anchor not at first position", () => {
    const items = [{ id: "a" }, { id: "b" }];
    expect(resolveChatListAnchoredEndSpace(items, "b", (x) => x.id)).toBeUndefined();
  });

  it("respects custom offset", () => {
    const items = [{ id: "a" }];
    expect(resolveChatListAnchoredEndSpace(items, "a", (x) => x.id, { anchorOffset: 32 })).toEqual({
      anchorIndex: 0,
      anchorOffset: 32,
    });
  });

  it("skips null ids and finds next", () => {
    const items = [{ id: null }, { id: "a" }];
    expect(resolveChatListAnchoredEndSpace(items as any, "a", (x: any) => x.id)).toEqual({
      anchorIndex: 1,
      anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
    });
  });

  it("returns undefined when first anchored item mismatches", () => {
    const items = [{ id: "b" }, { id: "a" }];
    expect(resolveChatListAnchoredEndSpace(items as any, "a", (x: any) => x.id)).toBeUndefined();
  });
});
