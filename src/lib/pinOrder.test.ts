import { describe, expect, it } from "vitest";
import {
  generateSpreadPinOrderKeys,
  pinOrderKeyBetween,
  planPinnedMove,
  planPinnedReorder,
  sortPinnedThreadsByOrderKey,
} from "./pinOrder";

describe("pinOrderKeyBetween", () => {
  it("returns midpoint between bounds", () => {
    const mid = pinOrderKeyBetween(null, null);
    expect(mid).toBeTruthy();
    expect(mid!.length).toBeGreaterThan(0);
  });

  it("returns null for corrupt keys", () => {
    expect(pinOrderKeyBetween("INVALID", null)).toBeNull();
  });

  it("returns between a and b", () => {
    const mid = pinOrderKeyBetween("m", "o");
    expect(mid).not.toBeNull();
    expect(mid! > "m" && mid! < "o").toBe(true);
  });
});

describe("generateSpreadPinOrderKeys", () => {
  it("generates count keys sorted", () => {
    const keys = generateSpreadPinOrderKeys(5);
    expect(keys).toHaveLength(5);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it("avoids trailing 'a'", () => {
    const keys = generateSpreadPinOrderKeys(10);
    for (const k of keys) expect(k.at(-1)).not.toBe("a");
  });
});

describe("planPinnedReorder", () => {
  it("single-write when neighbors keyed", () => {
    const keysById = new Map([
      ["a", "m"],
      ["b", "n"],
      ["c", "o"],
    ]);
    const result = planPinnedReorder({ orderedIds: ["a", "c", "b"], keysById, movedId: "c" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c");
  });

  it("rewrites section when neighbor keyless", () => {
    const keysById = new Map<string, string | null | undefined>([
      ["a", "m"],
      ["b", null],
      ["c", "o"],
    ]);
    const result = planPinnedReorder({ orderedIds: ["b", "a", "c"], keysById, movedId: "a" });
    expect(result.length).toBeGreaterThan(1);
  });
});

describe("sortPinnedThreadsByOrderKey", () => {
  it("sorts keyed first, then keyless by createdAt", () => {
    const threads = [
      { id: "1", createdAt: "2024-01-03T00:00:00Z", pinOrderKey: "z" },
      { id: "2", createdAt: "2024-01-01T00:00:00Z", pinOrderKey: "a" },
      { id: "3", createdAt: "2024-01-02T00:00:00Z", pinOrderKey: null },
    ];
    const sorted = sortPinnedThreadsByOrderKey(threads);
    expect(sorted.map((t) => t.id)).toEqual(["2", "1", "3"]);
  });
});

describe("planPinnedMove", () => {
  it("moves up", () => {
    const keysById = new Map([
      ["a", "m"],
      ["b", "n"],
      ["c", "o"],
    ]);
    const result = planPinnedMove({ orderedIds: ["a", "b", "c"], keysById, movedId: "b", direction: "up" });
    expect(result).not.toBeNull();
  });

  it("returns null at bounds", () => {
    const keysById = new Map([["a", "m"]]);
    expect(planPinnedMove({ orderedIds: ["a"], keysById, movedId: "a", direction: "up" })).toBeNull();
  });
});
