import { describe, expect, it } from "vitest";
import {
  cacheHitRate,
  countCompactions,
  effectiveTps,
  pushTurnSample,
  type TurnSample,
} from "./session-stats";

describe("cacheHitRate", () => {
  it("counts newly written cache tokens as misses, not hits", () => {
    expect(cacheHitRate({ cacheRead: 90, cacheWrite: 10, total: 100 })).toBe(0.9);
  });

  it.each([
    { name: "cold prompt", tokens: { input: 1000 }, expected: 0 },
    { name: "cache creation only", tokens: { cacheWrite: 1000 }, expected: 0 },
    { name: "cache read only", tokens: { cacheRead: 1000 }, expected: 1 },
    { name: "mixed reads and writes", tokens: { input: 100, cacheRead: 600, cacheWrite: 300 }, expected: 0.6 },
    { name: "no fresh input with writes", tokens: { cacheRead: 600, cacheWrite: 400 }, expected: 0.6 },
    { name: "output excluded", tokens: { input: 100, cacheRead: 600, cacheWrite: 300, output: 9000, total: 10000 }, expected: 0.6 },
  ])("accounts for $name", ({ tokens, expected }) => {
    expect(cacheHitRate(tokens)).toBeCloseTo(expected);
  });

  it("does not report output-only usage as a cache miss", () => {
    expect(cacheHitRate(undefined)).toBeNull();
    expect(cacheHitRate({ output: 500, total: 500 })).toBeNull();
  });

  it("weights session totals by prompt tokens rather than averaging turn percentages", () => {
    // Cold first turn: 100 fresh + 900 cache writes. Warm second: 100 fresh + 1900 reads.
    expect(cacheHitRate({ input: 200, cacheWrite: 900, cacheRead: 1900 })).toBeCloseTo(1900 / 3000);
  });

  it("is cacheRead over cacheRead plus fresh input", () => {
    expect(cacheHitRate({ input: 200, cacheRead: 800 })).toBeCloseTo(0.8);
  });

  it("is null without prompt tokens", () => {
    expect(cacheHitRate(null)).toBeNull();
    expect(cacheHitRate({})).toBeNull();
    expect(cacheHitRate({ input: 0, cacheRead: 0 })).toBeNull();
  });

  it("treats a fully cached prompt as a full hit", () => {
    expect(cacheHitRate({ input: 0, cacheRead: 1500 })).toBe(1);
  });
});

describe("countCompactions", () => {
  it("counts only completed compactions", () => {
    expect(
      countCompactions([
        { kind: "compaction", status: "compacted" },
        { kind: "compaction", status: "compacting" },
        { kind: "compaction", status: "aborted" },
        { kind: "compaction", status: "failed" },
        { kind: "compaction", status: "compacted" },
        { kind: "assistant" },
        { kind: "tool" },
      ])
    ).toBe(2);
  });

  it("excludes handoff boundaries", () => {
    expect(
      countCompactions([
        { kind: "compaction", status: "compacted", reason: "handoff from history" },
        { kind: "compaction", status: "compacted", reason: "auto" },
        { kind: "compaction", status: "compacted", reason: "manual" },
      ])
    ).toBe(2);
  });
});

describe("effectiveTps", () => {
  const sample = (outputTokens: number, ms: number): TurnSample => ({ outputTokens, ms });

  it("is total output over total time", () => {
    expect(effectiveTps([sample(100, 1000), sample(200, 2000)])).toBeCloseTo(100);
  });

  it("is null with no usable samples", () => {
    expect(effectiveTps([])).toBeNull();
    expect(effectiveTps([sample(0, 100)])).toBeNull();
  });
});

describe("pushTurnSample", () => {
  it("drops non-measurements", () => {
    expect(pushTurnSample([], { outputTokens: 0, ms: 500 })).toEqual([]);
    expect(pushTurnSample([], { outputTokens: 50, ms: 0 })).toEqual([]);
    expect(pushTurnSample([], { outputTokens: 50, ms: 500 })).toEqual([{ outputTokens: 50, ms: 500 }]);
  });

  it("keeps only the newest samples under the cap", () => {
    let samples: TurnSample[] = [];
    for (let i = 1; i <= 5; i++) samples = pushTurnSample(samples, { outputTokens: i, ms: 1000 }, 3);
    expect(samples.map((s) => s.outputTokens)).toEqual([3, 4, 5]);
  });
});
