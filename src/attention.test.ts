import { describe, expect, it } from "vitest";
import {
  addAttention,
  createAttentionRegistry,
  listAttention,
  listBySource,
  removeAttention,
  resolveAttention,
  type AttentionItem,
  type AttentionRegistry,
} from "./attention";

function item(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "i1",
    type: "permission",
    title: "git push required",
    source: "main",
    createdAt: 1,
    resolved: false,
    ...over,
  };
}

describe("attention inbox", () => {
  it("adds an item and refuses to overwrite", () => {
    let r: AttentionRegistry = createAttentionRegistry();
    r = addAttention(r, item());
    expect(r.items.i1.title).toBe("git push required");
    r = addAttention(r, item({ title: "other" }));
    expect(r.items.i1.title).toBe("git push required");
  });

  it("resolves an item and is a no-op on a missing/already-resolved one", () => {
    let r = addAttention(createAttentionRegistry(), item());
    r = resolveAttention(r, "i1");
    expect(r.items.i1.resolved).toBe(true);
    expect(resolveAttention(r, "i1")).toBe(r);
    expect(resolveAttention(r, "missing")).toBe(r);
  });

  it("removes an item (no-op when absent)", () => {
    const r = addAttention(createAttentionRegistry(), item());
    const removed = removeAttention(r, "i1");
    expect(removed.items.i1).toBeUndefined();
    expect(removeAttention(removed, "i1")).toBe(removed);
  });

  it("lists unresolved first, newest first", () => {
    let r = createAttentionRegistry();
    r = addAttention(r, item({ id: "a", createdAt: 1, title: "old" }));
    r = addAttention(r, item({ id: "b", createdAt: 5, title: "new" }));
    r = resolveAttention(r, "a");
    const listed = listAttention(r).map((i) => i.id);
    expect(listed).toEqual(["b"]);
  });

  it("filters by source", () => {
    let r = createAttentionRegistry();
    r = addAttention(r, item({ id: "a", source: "main" }));
    r = addAttention(r, item({ id: "b", source: "worker" }));
    expect(listBySource(r, "main").map((i) => i.id)).toEqual(["a"]);
  });
});
