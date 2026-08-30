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
});
