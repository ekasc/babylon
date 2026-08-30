import { describe, expect, it } from "vitest";
import { pickStrategy } from "./strategy";
import type { SnapcompactArchive } from "./types";

const archive: SnapcompactArchive = {
  version: 1,
  sessionId: "s1",
  sessionFile: "/sessions/s1.jsonl",
  strategy: "snapcompact",
  sourceText: "head",
  symbols: [],
  frames: [],
  coveredThroughMessageId: "m1",
  createdAt: 0,
  coveredThroughTimestamp: 0,
  frameWidth: 64,
  frameHeight: 32,
  profileId: "generic-vision",
  frameBytes: 0,
};

describe("snapcompact strategy", () => {
  it("returns summary when mode is summary", () => {
    expect(pickStrategy({ model: null, mode: "summary", archive: null, archiveProducible: false, archiveMatchesSession: false }).strategy).toBe("summary");
  });
  it("returns summary when mode is automatic and model lacks image input", () => {
    const r = pickStrategy({ model: { input: ["text"] }, mode: "automatic", archive, archiveProducible: true, archiveMatchesSession: true });
    expect(r.strategy).toBe("summary");
    expect(r.reason).toMatch(/image input/);
  });
  it("returns summary when no archive exists and cannot be produced", () => {
    const r = pickStrategy({ model: { input: ["text", "image"] }, mode: "automatic", archive: null, archiveProducible: false, archiveMatchesSession: false });
    expect(r.strategy).toBe("summary");
    expect(r.reason).toMatch(/cannot be produced/);
  });
  it("returns summary when an archive exists but does not match the session", () => {
    const r = pickStrategy({ model: { input: ["text", "image"] }, mode: "automatic", archive, archiveProducible: true, archiveMatchesSession: false });
    expect(r.strategy).toBe("summary");
    expect(r.reason).toMatch(/different session/);
  });
  it("returns snapcompact when all gates pass", () => {
    const r = pickStrategy({ model: { input: ["text", "image"] }, mode: "automatic", archive, archiveProducible: true, archiveMatchesSession: true });
    expect(r.strategy).toBe("snapcompact");
  });
  it("returns summary when there is no active model", () => {
    const r = pickStrategy({ model: null, mode: "automatic", archive, archiveProducible: true, archiveMatchesSession: true });
    expect(r.strategy).toBe("summary");
  });
});
