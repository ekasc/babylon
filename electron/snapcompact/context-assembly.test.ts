import { describe, expect, it } from "vitest";
import { buildContextProjection, assembleUserMessage } from "./context-assembly";
import type { SnapcompactArchive, SnapcompactFrame, SnapcompactSymbol } from "./types";

function pngStub(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 13, 10, 26, 10]);
}

const symbols: SnapcompactSymbol[] = [
  { id: "E001", value: "/repo/electron/snapshot-store.ts", kind: "path" },
  { id: "E002", value: "a1b2c3d4e5f6", kind: "sha" },
];

const frames: SnapcompactFrame[] = [
  { index: 0, width: 64, height: 32, png: pngStub(), sourceOffset: 0, sourceEnd: 100 },
  { index: 1, width: 64, height: 32, png: pngStub(), sourceOffset: 100, sourceEnd: 200 },
];

function makeArchive(sourceText: string): SnapcompactArchive {
  return {
    version: 1,
    sessionId: "s1",
    sessionFile: "/sessions/s1.jsonl",
    strategy: "snapcompact",
    sourceText,
    symbols,
    frames,
    coveredThroughMessageId: "m1",
    createdAt: 0,
    coveredThroughTimestamp: 0,
    frameWidth: 64,
    frameHeight: 32,
    profileId: "generic-vision",
    frameBytes: frames.reduce((n, f) => n + f.png.length, 0),
    compactionGenerationId: "gen-test",
    firstKeptEntryId: "m1",
    lastKeptEntryId: "m1",
    keptCount: 1,
    omittedTrailing: [],
  };
}

describe("snapcompact context assembly", () => {
  it("emits one image per frame in chronological order", () => {
    const p = buildContextProjection(makeArchive("hello"));
    expect(p.images).toHaveLength(2);
    expect(p.images[0].mimeType).toBe("image/png");
    expect(p.images[0].data).toBeInstanceOf(Buffer);
  });
  it("includes the symbol dictionary as raw text in the header", () => {
    const p = buildContextProjection(makeArchive("hello"));
    expect(p.headerText).toContain("E001=/repo/electron/snapshot-store.ts");
    expect(p.headerText).toContain("E002=a1b2c3d4e5f6");
    expect(p.headerText).toContain("symbol dictionary");
  });
  it("includes a head / tail excerpt of the source text in the header", () => {
    const long = "alpha ".repeat(2_000);
    const p = buildContextProjection(makeArchive(long));
    expect(p.headerText).toContain("archive head");
    expect(p.headerText).toContain("archive tail");
    expect(p.headerText).toContain("alpha");
  });
  it("assembleUserMessage prepends the header before the user message", () => {
    const p = buildContextProjection(makeArchive("hello"));
    const out = assembleUserMessage("user said this", p);
    expect(out.indexOf("[Snapcompact archive]")).toBe(0);
    expect(out.endsWith("user said this")).toBe(true);
  });
  it("assembleUserMessage passes the message through unchanged when projection is unused", () => {
    const out = assembleUserMessage("plain", { images: [], headerText: "", usedSnapcompact: false });
    expect(out).toBe("plain");
  });
  it("marks usedSnapcompact=false when there is no archive to project", () => {
    const p = { images: [], headerText: "", usedSnapcompact: false };
    expect(assembleUserMessage("x", p)).toBe("x");
  });
});
