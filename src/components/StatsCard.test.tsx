// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import StatsCard from "./StatsCard";
import type { TokenUsage } from "../lib/session-stats";

afterEach(cleanup);

describe("StatsCard", () => {
  it("updates cache hit display from cold to warm and clears it on session reset", () => {
    const props = {
      compactionCount: 0,
      samples: [],
      initialPos: { x: 10, y: 10 },
      onMove: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<StatsCard {...props} tokens={null} />);
    const stages: Array<{ tokens: TokenUsage | null; expected: string }> = [
      { tokens: null, expected: "—" },
      { tokens: { cacheWrite: 1000 }, expected: "0%" },
      { tokens: { input: 200, cacheWrite: 900, cacheRead: 1900 }, expected: "63%" },
      { tokens: { cacheRead: 1500 }, expected: "100%" },
      { tokens: null, expected: "—" },
    ];
    for (const { tokens, expected } of stages) {
      rerender(<StatsCard {...props} tokens={tokens} />);
      expect(screen.getByText("Cache hit").nextElementSibling?.textContent).toBe(expected);
    }
  });

  it("shows all six session metrics with derived values", () => {
    render(
      <StatsCard
        tokens={{ input: 1234, output: 567, cacheRead: 800 }}
        totalMessages={42}
        compactionCount={3}
        samples={[
          { outputTokens: 100, ms: 1000 },
          { outputTokens: 300, ms: 3000 },
        ]}
        initialPos={{ x: 10, y: 10 }}
        onMove={vi.fn()}
        onClose={vi.fn()}
      />
    );

    for (const label of [
      "Input tokens",
      "Output tokens",
      "Compactions",
      "TPS",
      "Cache hit",
      "Messages",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    expect(screen.getByText("1.23K")).toBeTruthy();
    expect(screen.getByText("567")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    // 400 output tokens over 4s of measured time.
    expect(screen.getByText("100.0")).toBeTruthy();
    // 800 cached ÷ (800 + 1234) prompt tokens.
    expect(screen.getByText("39%")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("degrades to dashes when nothing has been measured yet", () => {
    render(
      <StatsCard
        tokens={null}
        compactionCount={0}
        samples={[]}
        initialPos={{ x: 10, y: 10 }}
        onMove={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getAllByText("—")).toHaveLength(2);
    // Input, output, compactions, and messages all read 0 with no data.
    expect(screen.getAllByText("0")).toHaveLength(4);
  });
});
