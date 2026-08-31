import { describe, expect, it } from "vitest";
import { buildArchive, ArchiveBudgetError } from "./build";
import { profileForModel } from "./model-profiles";

function user(text: string, entryId = "u-" + Math.random().toString(36).slice(2, 6)) {
  return { role: "user" as const, content: text, entryId, timestamp: 0 };
}

describe("snapcompact build budgets", () => {
  it("enforces the source-text budget via the serializer", () => {
    const profile = { ...profileForModel({ id: "generic-vision" }), maxSourceChars: 2_000 };
    const messages = Array.from({ length: 100 }, (_, i) => user("a".repeat(200), `u${i}`));
    const r = buildArchive({ sessionId: "s", sessionFile: "/s.jsonl", messages, profile });
    expect(r.archive.sourceText.length).toBeLessThanOrEqual(2_000);
    expect(r.archive.omittedTrailing.length).toBeGreaterThan(0);
    expect(r.archive.keptCount).toBeLessThan(100);
  });

  it("enforces the symbol-count budget", () => {
    const profile = { ...profileForModel({ id: "generic-vision" }), maxSymbolCount: 3, maxDictChars: 10_000 };
    const messages = [user("/repo/a.ts /repo/b.ts /repo/c.ts /repo/d.ts /repo/e.ts", "u1")];
    const r = buildArchive({ sessionId: "s", sessionFile: "/s.jsonl", messages, profile });
    expect(r.archive.symbols.length).toBeLessThanOrEqual(3);
  });

  it("enforces the maxArchiveBytes budget (throws ArchiveBudgetError)", () => {
    const profile = { ...profileForModel({ id: "generic-vision" }), maxArchiveBytes: 1 };
    const messages = Array.from({ length: 50 }, (_, i) => user("line " + i + "\n", `u${i}`));
    expect(() => buildArchive({ sessionId: "s", sessionFile: "/s.jsonl", messages, profile })).toThrow(ArchiveBudgetError);
  });

  it("sets compactionGenerationId and truthful coverage", () => {
    const messages = [user("a", "u1"), user("b", "u2")];
    const profile = profileForModel({ id: "generic-vision" });
    const r = buildArchive({ sessionId: "s", sessionFile: "/s.jsonl", messages, profile });
    expect(r.archive.compactionGenerationId).toMatch(/[0-9a-f-]{36}/);
    expect(r.archive.firstKeptEntryId).toBe("u1");
    expect(r.archive.lastKeptEntryId).toBe("u2");
    expect(r.archive.keptCount).toBe(2);
  });

  it("hard-caps maxDictChars even for a single oversized symbol (drops it)", () => {
    const profile = { ...profileForModel({ id: "generic-vision" }), maxDictChars: 100 };
    const longUrl = "https://example.com/" + "a".repeat(5000);
    const messages = [user(`see ${longUrl} please`, "u1")];
    const r = buildArchive({ sessionId: "s", sessionFile: "/s.jsonl", messages, profile });
    // Single huge URL exceeds 100 char dict budget -> discarded
    expect(r.archive.symbols.find((s) => s.value === longUrl)).toBeUndefined();
    // Budget still enforced: total dict chars within limit
    const dictChars = r.archive.symbols.reduce((n, s) => n + s.value.length, 0);
    expect(dictChars).toBeLessThanOrEqual(100);
  });

  it("enforces maxImageTokens", () => {
    const profile = { ...profileForModel({ id: "generic-vision" }), maxImageTokens: 1 };
    const messages = [user("hello world", "u1")];
    expect(() => buildArchive({ sessionId: "s", sessionFile: "/s.jsonl", messages, profile })).toThrow(ArchiveBudgetError);
  });

  it("enforces maxRequestBytes", () => {
    const profile = { ...profileForModel({ id: "generic-vision" }), maxRequestBytes: 1 };
    const messages = [user("hello world", "u1")];
    expect(() => buildArchive({ sessionId: "s", sessionFile: "/s.jsonl", messages, profile })).toThrow(ArchiveBudgetError);
  });

  it("stores a durable textFallback for text-only fallback", () => {
    const messages = [user("hello /repo/a.ts", "u1")];
    const profile = profileForModel({ id: "generic-vision" });
    const r = buildArchive({ sessionId: "s", sessionFile: "/s.jsonl", messages, profile });
    expect(typeof r.archive.textFallback).toBe("string");
    expect(r.archive.textFallback!.length).toBeGreaterThan(0);
    expect(r.archive.textFallback!).toContain("[Snapcompact text fallback]");
  });

  it("cumulative rollover retains previous source (G2 contains OLD + NEW)", () => {
    const profile = profileForModel({ id: "generic-vision" });
    const g1 = buildArchive({ sessionId: "s", sessionFile: "/s.jsonl", messages: [user("OLD_FACT_123", "u1")], profile });
    const g2 = buildArchive({ sessionId: "s", sessionFile: "/s.jsonl", messages: [user("NEW_FACT_456", "u2")], profile, previousArchive: g1.archive });
    expect(g2.archive.sourceText).toContain("OLD_FACT_123");
    expect(g2.archive.sourceText).toContain("NEW_FACT_456");
    expect(g2.archive.keptCount).toBeGreaterThan(g1.archive.keptCount);
  });

  it("cumulative rollover respects budget and records eviction, not silent loss", () => {
    const profile = { ...profileForModel({ id: "generic-vision" }), maxSourceChars: 100 };
    const g1 = buildArchive({ sessionId: "s", sessionFile: "/s.jsonl", messages: [user("A".repeat(80), "u1")], profile });
    const g2 = buildArchive({ sessionId: "s", sessionFile: "/s.jsonl", messages: [user("B".repeat(80), "u2")], profile, previousArchive: g1.archive });
    expect(g2.archive.sourceText.length).toBeLessThanOrEqual(100);
    expect(g2.archive.omittedTrailing.length).toBeGreaterThan(0);
  });
});
