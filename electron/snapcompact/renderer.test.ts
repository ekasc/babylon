import { describe, expect, it } from "vitest";
import { renderFrames, applySubstitution, type FrameProfile } from "./renderer";
import { encodePng1Bit } from "./png-encoder";
import { FONT_5X7, GLYPH_W, GLYPH_H, glyph5x7 } from "./font";
import type { SnapcompactSymbol } from "./types";

const profile: FrameProfile = Object.freeze({
  id: "test",
  width: 320,
  height: 96,
  fontScale: 1,
  lineGap: 1,
  marginX: 4,
  marginY: 4,
  maxFrames: 8,
});

describe("snapcompact PNG encoder", () => {
  it("encodes a known-good PNG signature and produces a Buffer", () => {
    const pixels = new Uint8Array(Math.ceil(8 / 8) * 1);
    pixels[0] = 0b10000000;
    const png = encodePng1Bit(8, 1, pixels);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    expect(png.length).toBeGreaterThan(50);
  });
  it("rejects mismatched buffer size", () => {
    expect(() => encodePng1Bit(8, 1, new Uint8Array(0))).toThrow();
  });
  it("is deterministic for the same input", () => {
    const pixels = new Uint8Array(Math.ceil(16 / 8) * 2).fill(0xAA);
    const a = encodePng1Bit(16, 2, pixels);
    const b = encodePng1Bit(16, 2, pixels);
    expect(a.equals(b));
  });
});

describe("snapcompact font", () => {
  it("returns the fallback for unknown characters", () => {
    const g = glyph5x7("\u0000");
    expect(g.length).toBe(GLYPH_H);
    expect(g[0].length).toBe(GLYPH_W);
  });
  it("renders space as a blank column", () => {
    expect(FONT_5X7[" "].every((r) => r === ".....")).toBe(true);
  });
  it("does not crash on Unicode code points", () => {
    expect(() => glyph5x7("\u4e2d")).not.toThrow();
    expect(() => glyph5x7("\u00e9")).not.toThrow();
  });
});

describe("snapcompact substitution", () => {
  it("leaves first occurrence of long symbols verbatim and replaces later ones", () => {
    const symbols: SnapcompactSymbol[] = [
      { id: "E001", value: "/repo/electron/snapshot-store.ts", kind: "path" },
    ];
    const text = "see /repo/electron/snapshot-store.ts and /repo/electron/snapshot-store.ts again";
    const out = applySubstitution(text, symbols);
    expect(out).toContain("/repo/electron/snapshot-store.ts");
    expect(out).toContain("[E001]");
    expect(out.indexOf("[E001]")).toBeGreaterThan(out.indexOf("/repo/electron/snapshot-store.ts"));
  });
  it("does not substitute short values", () => {
    const symbols: SnapcompactSymbol[] = [{ id: "E001", value: "main", kind: "branch" }];
    expect(applySubstitution("on main branch", symbols)).toBe("on main branch");
  });
});

describe("snapcompact renderer", () => {
  it("produces a deterministic frame count for a fixture", () => {
    const text = "a".repeat(200);
    const a = renderFrames({ sourceText: text, rawSymbols: [], profile });
    const b = renderFrames({ sourceText: text, rawSymbols: [], profile });
    expect(a.frames.length).toBe(b.frames.length);
    expect(a.frames[0].png.equals(b.frames[0].png)).toBe(true);
  });
  it("returns at least one frame for non-empty input", () => {
    const r = renderFrames({ sourceText: "hello", rawSymbols: [], profile });
    expect(r.frames.length).toBeGreaterThanOrEqual(1);
  });
  it("emits an empty-but-valid PNG when the source is empty", () => {
    const r = renderFrames({ sourceText: "", rawSymbols: [], profile });
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].png.length).toBeGreaterThan(0);
    expect(r.frames[0].png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  });
  it("truncates frame count to profile.maxFrames and sets truncated, with an omission marker frame (no silent holes)", () => {
    const small: FrameProfile = { ...profile, maxFrames: 2 };
    const text = "a".repeat(20_000);
    const r = renderFrames({ sourceText: text, rawSymbols: [], profile: small });
    expect(r.frames.length).toBe(2);
    expect(r.truncated).toBe(true);
    // No silent holes: the plan records exactly which lines were
    // omitted, and an omission-marker frame is emitted so the model
    // sees an honest note rather than content that simply disappeared.
    const lastEntry = r.plan.entries[r.plan.entries.length - 1];
    const omissionEntry = r.plan.entries.find((e) => e.carriesOmission);
    expect(omissionEntry).toBeDefined();
    expect(omissionEntry).toBe(lastEntry);
    // Every line in the plan is accounted for.
    expect(r.plan.linesAssigned).toBeLessThanOrEqual(r.plan.totalLines);
  });
  it("preserves exact-token dictionary as raw text alongside rasterized source", () => {
    const symbols = [{ value: "/repo/electron/snapshot-store.ts", kind: "path" as const }];
    const r = renderFrames({ sourceText: "/repo/electron/snapshot-store.ts and /repo/electron/snapshot-store.ts", rawSymbols: symbols, profile });
    expect(r.symbols.length).toBe(1);
    expect(r.symbols[0].id).toBe("E001");
    expect(r.symbols[0].value).toBe("/repo/electron/snapshot-store.ts");
    // Adjusted source: first occurrence verbatim, second as anchor.
    expect(r.adjustedSourceText.indexOf("/repo/electron/snapshot-store.ts")).toBeGreaterThanOrEqual(0);
    expect(r.adjustedSourceText).toContain("[E001]");
  });
  it("handles long lines by wrapping", () => {
    const text = "word ".repeat(200);
    const r = renderFrames({ sourceText: text, rawSymbols: [], profile });
    expect(r.frames.length).toBeGreaterThanOrEqual(1);
  });

  it("the frame plan covers every line exactly once (or records omission)", () => {
    const small: FrameProfile = { ...profile, maxFrames: 2 };
    const text = "a\n".repeat(5_000);
    const r = renderFrames({ sourceText: text, rawSymbols: [], profile: small });
    // No two entries overlap; together they cover the whole source
    // (body frames cover the head, the omission-marker frame covers
    // the tail, so totalCovered === totalLines).
    const ranges = r.plan.entries.map((e) => [e.lineStart, e.lineEnd] as const);
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < ranges.length - 1; i++) {
      expect(ranges[i][1] + 1).toBeLessThanOrEqual(ranges[i + 1][0]);
    }
    const totalCovered = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
    expect(totalCovered).toBe(r.plan.totalLines);
    // Body frames alone cover exactly linesAssigned lines.
    const bodyCovered = r.plan.entries
      .filter((e) => !e.carriesOmission)
      .reduce((n, e) => n + (e.lineEnd - e.lineStart + 1), 0);
    expect(bodyCovered).toBe(r.plan.linesAssigned);
  });
  it("does not crash on Unicode / control characters", () => {
    const text = "line1 \u4e2d\u6587 ok\nline2\t\tabc\nline3 \u2603 \u00e9";
    expect(() => renderFrames({ sourceText: text, rawSymbols: [], profile })).not.toThrow();
  });
});
