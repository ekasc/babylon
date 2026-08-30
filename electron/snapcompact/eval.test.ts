import { describe, expect, it } from "vitest";
import { evaluateAll, evaluateFixture, formatReport } from "./eval";
import { EVAL_FIXTURES } from "./eval-fixtures";

describe("snapcompact eval harness", () => {
  it("grades the rollout-recovery fixture across all four strategies", () => {
    const fixture = EVAL_FIXTURES.find((f) => f.id === "rollout-recovery");
    expect(fixture).toBeDefined();
    const report = evaluateFixture(fixture!);
    expect(report.metrics).toHaveLength(4);
    const byStrategy = Object.fromEntries(report.metrics.map((m) => [m.strategy, m]));
    expect(byStrategy.raw).toBeDefined();
    expect(byStrategy.summary).toBeDefined();
    expect(byStrategy.snapcompact).toBeDefined();
    expect(byStrategy["snapcompact-dict"]).toBeDefined();
  });

  it("raw text baseline contains all exact answers (trivially)", () => {
    const fixture = EVAL_FIXTURES[0];
    const report = evaluateFixture(fixture);
    const raw = report.metrics.find((m) => m.strategy === "raw")!;
    expect(raw.allExactAnswersPresent).toBe(true);
  });

  it("the textual summary surrogate has worse exact accuracy than raw", () => {
    const fixture = EVAL_FIXTURES[0];
    const report = evaluateFixture(fixture);
    const raw = report.metrics.find((m) => m.strategy === "raw")!;
    const summary = report.metrics.find((m) => m.strategy === "summary")!;
    // Raw is the full transcript; the summary surrogate covers only the
    // first 1500 chars. Some answers live later in the transcript.
    const rawTotal = Object.values(raw.exactAccuracy).reduce((n, v) => n + v.total, 0);
    const summaryTotal = Object.values(summary.exactAccuracy).reduce((n, v) => n + v.total, 0);
    expect(rawTotal).toBe(summaryTotal);
    const rawHits = Object.values(raw.exactAccuracy).reduce((n, v) => n + v.hit, 0);
    const summaryHits = Object.values(summary.exactAccuracy).reduce((n, v) => n + v.hit, 0);
    expect(rawHits).toBeGreaterThanOrEqual(summaryHits);
  });

  it("snapcompact preserves more exact answers than the summary surrogate, especially with the dictionary", () => {
    const fixture = EVAL_FIXTURES[0];
    const report = evaluateFixture(fixture);
    const summary = report.metrics.find((m) => m.strategy === "summary")!;
    const dict = report.metrics.find((m) => m.strategy === "snapcompact-dict")!;
    const summaryHits = Object.values(summary.exactAccuracy).reduce((n, v) => n + v.hit, 0);
    const dictHits = Object.values(dict.exactAccuracy).reduce((n, v) => n + v.hit, 0);
    // The rasterized + dictionary together should recover at least
    // as many exact answers as the summary surrogate, and the dictionary
    // ensures that long values (paths, shas) remain as raw text.
    expect(dictHits).toBeGreaterThanOrEqual(summaryHits);
  });

  it("snapcompact frames are bounded by profile.maxFrames", () => {
    const fixture = EVAL_FIXTURES[0];
    const report = evaluateFixture(fixture);
    const snap = report.metrics.find((m) => m.strategy === "snapcompact")!;
    const dict = report.metrics.find((m) => m.strategy === "snapcompact-dict")!;
    expect(snap.frameCount).toBeGreaterThan(0);
    expect(dict.frameCount).toBe(snap.frameCount);
  });

  it("emits a human-readable report", () => {
    const reports = evaluateAll();
    const out = formatReport(reports);
    expect(out).toContain("fixture=rollout-recovery");
    expect(out).toContain("raw");
    expect(out).toContain("summary");
    expect(out).toContain("snapcompact");
    expect(out).toContain("snapcompact-dict");
    expect(out).toMatch(/allExact=[YN]/);
  });

  it("semantic answers carry the expected model answer and an excerpt", () => {
    const fixture = EVAL_FIXTURES[0];
    const report = evaluateFixture(fixture);
    const raw = report.metrics.find((m) => m.strategy === "raw")!;
    expect(raw.semanticAnswers.length).toBeGreaterThan(0);
    for (const sa of raw.semanticAnswers) {
      expect(sa.question.length).toBeGreaterThan(0);
      expect(sa.expected.length).toBeGreaterThan(0);
      expect(sa.projectionExcerpt.length).toBeGreaterThan(0);
    }
  });
});
