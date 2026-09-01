import { describe, expect, it } from "vitest";
import {
  compareRankedSearchResults,
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  scoreSubsequenceMatch,
} from "./searchRanking";

describe("normalizeSearchQuery", () => {
  it("trims and lowercases", () => {
    expect(normalizeSearchQuery("  Hello ")).toBe("hello");
  });
  it("strips leading pattern", () => {
    expect(normalizeSearchQuery("/hello", { trimLeadingPattern: /^\// })).toBe("hello");
  });
});

describe("scoreSubsequenceMatch", () => {
  it("returns 0 for empty query", () => {
    expect(scoreSubsequenceMatch("abc", "")).toBe(0);
  });
  it("scores contiguous match", () => {
    expect(scoreSubsequenceMatch("hello", "he")).not.toBeNull();
  });
  it("returns null for no match", () => {
    expect(scoreSubsequenceMatch("hello", "z")).toBeNull();
  });
});

describe("scoreQueryMatch", () => {
  it("exact", () => {
    expect(scoreQueryMatch({ value: "hello", query: "hello", exactBase: 0 })).toBe(0);
  });
  it("prefix", () => {
    expect(scoreQueryMatch({ value: "hello world", query: "hello", exactBase: 0, prefixBase: 10 })).toBe(10 + 6);
  });
  it("fuzzy", () => {
    const s = scoreQueryMatch({ value: "hello", query: "hl", exactBase: 100, fuzzyBase: 50 });
    expect(s).not.toBeNull();
  });
});

describe("compare/insert", () => {
  it("inserts sorted", () => {
    const list: any[] = [];
    insertRankedSearchResult(list, { item: "a", score: 10, tieBreaker: "a" }, 3);
    insertRankedSearchResult(list, { item: "b", score: 5, tieBreaker: "b" }, 3);
    expect(list[0].item).toBe("b");
  });
  it("respects limit", () => {
    const list = [
      { item: "a", score: 1, tieBreaker: "a" },
      { item: "b", score: 2, tieBreaker: "b" },
    ];
    insertRankedSearchResult(list, { item: "c", score: 10, tieBreaker: "c" }, 2);
    expect(list).toHaveLength(2);
  });
  it("compare tieBreaker", () => {
    expect(compareRankedSearchResults({ item: 1, score: 5, tieBreaker: "a" }, { item: 2, score: 5, tieBreaker: "b" })).toBeLessThan(0);
  });
});
