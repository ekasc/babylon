import { describe, expect, it } from "vitest";
import { pickStrategy } from "./strategy";
import type { SnapcompactArchive } from "./types";

const modelWithImages = { provider: "openai", id: "gpt-4o", input: ["text", "image"] };
const modelTextOnly = { provider: "openai", id: "gpt-3.5", input: ["text"] };

const archive: SnapcompactArchive = {
  version: 1,
  sessionId: "s1",
  sessionFile: "/sessions/s1.jsonl",
  strategy: "snapcompact",
  sourceText: "x",
  symbols: [],
  frames: [],
  coveredThroughMessageId: "m1",
  createdAt: 0,
  coveredThroughTimestamp: 0,
  frameWidth: 64,
  frameHeight: 32,
  profileId: "generic-vision",
  frameBytes: 0,
  compactionGenerationId: "gen-x",
  firstKeptEntryId: "m1",
  lastKeptEntryId: "m1",
  keptCount: 1,
  omittedTrailing: [],
};

describe("snapcompact strategy matrix", () => {
  it("summary mode always returns summary", () => {
    expect(pickStrategy({ model: modelWithImages, mode: "summary", archive, archiveProducible: true, archiveMatchesSession: true }).strategy).toBe("summary");
    expect(pickStrategy({ model: null, mode: "summary", archive: null, archiveProducible: false, archiveMatchesSession: false }).strategy).toBe("summary");
  });

  it("snapcompact (explicit) + vision + producible + archive + match => snapcompact", () => {
    expect(pickStrategy({ model: modelWithImages, mode: "snapcompact", archive, archiveProducible: true, archiveMatchesSession: true }).strategy).toBe("snapcompact");
  });

  it("snapcompact (explicit) + visionless model => summary", () => {
    const r = pickStrategy({ model: modelTextOnly, mode: "snapcompact", archive, archiveProducible: true, archiveMatchesSession: true });
    expect(r.strategy).toBe("summary");
    expect(r.reason).toMatch(/image input/);
  });

  it("snapcompact (explicit) + failed archive build (archiveProducible=false) => summary", () => {
    const r = pickStrategy({ model: modelWithImages, mode: "snapcompact", archive, archiveProducible: false, archiveMatchesSession: true });
    expect(r.strategy).toBe("summary");
    expect(r.reason).toMatch(/cannot be produced/);
  });

  it("snapcompact (explicit) + no model => summary", () => {
    const r = pickStrategy({ model: null, mode: "snapcompact", archive, archiveProducible: true, archiveMatchesSession: true });
    expect(r.strategy).toBe("summary");
    expect(r.reason).toMatch(/no active model/);
  });

  it("snapcompact (explicit) + no archive => summary", () => {
    const r = pickStrategy({ model: modelWithImages, mode: "snapcompact", archive: null, archiveProducible: true, archiveMatchesSession: false });
    expect(r.strategy).toBe("summary");
  });

  it("snapcompact (explicit) + archive session mismatch => summary", () => {
    const r = pickStrategy({ model: modelWithImages, mode: "snapcompact", archive, archiveProducible: true, archiveMatchesSession: false });
    expect(r.strategy).toBe("summary");
  });

  it("automatic + vision + valid archive => snapcompact", () => {
    const r = pickStrategy({ model: modelWithImages, mode: "automatic", archive, archiveProducible: true, archiveMatchesSession: true });
    expect(r.strategy).toBe("snapcompact");
  });

  it("automatic + visionless => summary", () => {
    const r = pickStrategy({ model: modelTextOnly, mode: "automatic", archive, archiveProducible: true, archiveMatchesSession: true });
    expect(r.strategy).toBe("summary");
  });

  it("automatic + no archive => summary", () => {
    const r = pickStrategy({ model: modelWithImages, mode: "automatic", archive: null, archiveProducible: true, archiveMatchesSession: false });
    expect(r.strategy).toBe("summary");
  });
});
