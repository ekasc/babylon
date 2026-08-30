import { describe, expect, it } from "vitest";
import { evaluateAllCoverage, formatCoverageReport, emitLiveRequest } from "./eval";
import { EVAL_FIXTURES } from "./eval-fixtures";

describe("snapcompact offline coverage harness", () => {
  it("evaluates the rollout-recovery fixture across all four projections", () => {
    const reports = evaluateAllCoverage();
    const fixture = reports.find((r) => r.fixtureId === "rollout-recovery");
    expect(fixture).toBeDefined();
    expect(fixture!.metrics).toHaveLength(4);
    const byStrategy = Object.fromEntries(fixture!.metrics.map((m) => [m.strategy, m]));
    expect(byStrategy.raw).toBeDefined();
    expect(byStrategy["prefix-control"]).toBeDefined();
    expect(byStrategy.snapcompact).toBeDefined();
    expect(byStrategy["snapcompact-dict"]).toBeDefined();
  });

  it("raw text baseline is the full serialized source and the only projection with no holes and no dictionary", () => {
    const reports = evaluateAllCoverage();
    const fixture = reports.find((r) => r.fixtureId === "rollout-recovery")!;
    const raw = fixture.metrics.find((m) => m.strategy === "raw")!;
    expect(raw.rasterizedTextChars).toBeGreaterThan(0);
    expect(raw.dictionaryTextChars).toBe(0);
    expect(raw.frameCount).toBe(0);
    expect(raw.hasSilentHoles).toBe(false);
  });

  it("prefix-control is labelled as a deterministic prefix control (not 'existing summary compaction')", () => {
    const reports = evaluateAllCoverage();
    const fixture = reports.find((r) => r.fixtureId === "rollout-recovery")!;
    const prefix = fixture.metrics.find((m) => m.strategy === "prefix-control")!;
    expect(prefix.rasterizedTextChars).toBe(1500);
    expect(prefix.dictionaryTextChars).toBe(0);
    expect(prefix.truncated).toBe(true);
  });

  it("snapcompact archive has frames, an image token estimate, and a frame plan that does not have silent holes", () => {
    const reports = evaluateAllCoverage();
    const fixture = reports.find((r) => r.fixtureId === "rollout-recovery")!;
    const snap = fixture.metrics.find((m) => m.strategy === "snapcompact")!;
    expect(snap.frameCount).toBeGreaterThan(0);
    expect(snap.imageTokenEstimate).toBeGreaterThan(0);
    expect(snap.hasSilentHoles).toBe(false);
  });

  it("snapcompact-dict dictionary block contains the expected anchors", () => {
    const reports = evaluateAllCoverage();
    const fixture = reports.find((r) => r.fixtureId === "rollout-recovery")!;
    const dict = fixture.metrics.find((m) => m.strategy === "snapcompact-dict")!;
    expect(dict.dictionaryTextChars).toBeGreaterThan(0);
    expect(dict.dictionaryHasExpectedAnchors).toBe(true);
  });

  it("archive coverage is truthful (firstKeptEntryId / lastKeptEntryId / keptCount / omittedCount)", () => {
    const reports = evaluateAllCoverage();
    const fixture = reports.find((r) => r.fixtureId === "rollout-recovery")!;
    expect(fixture.archiveCoverage.firstKeptEntryId).toBe("u0");
    expect(fixture.archiveCoverage.lastKeptEntryId).not.toBeNull();
    expect(fixture.archiveCoverage.keptCount).toBeGreaterThan(0);
    expect(fixture.archiveCoverage.omittedCount).toBe(0);
  });

  it("emits a human-readable coverage report", () => {
    const reports = evaluateAllCoverage();
    const out = formatCoverageReport(reports);
    expect(out).toContain("fixture=rollout-recovery");
    expect(out).toContain("raw");
    expect(out).toContain("prefix-control");
    expect(out).toContain("snapcompact");
    expect(out).toContain("snapcompact-dict");
    expect(out).toContain("archiveCoverage");
  });
});

describe("snapcompact live retrieval scaffold", () => {
  it("emits a model-ready request with frames as base64 ImageContent", () => {
    const req = emitLiveRequest(EVAL_FIXTURES[0]);
    expect(req.frames.length).toBeGreaterThan(0);
    for (const f of req.frames) {
      expect(typeof f.base64).toBe("string");
      expect(f.base64.length).toBeGreaterThan(0);
      expect(f.base64).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(f.width).toBeGreaterThan(0);
      expect(f.height).toBeGreaterThan(0);
    }
    expect(req.headerText).toContain("[Snapcompact archive]");
    expect(req.dictionaryText.length).toBeGreaterThan(0);
    expect(req.questions.length).toBeGreaterThan(0);
    expect(req.totalRequestBytes).toBeGreaterThan(0);
  });
});
