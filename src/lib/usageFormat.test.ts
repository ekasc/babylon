import { describe, expect, it } from "vitest";
import { formatCount, formatPercent, formatTokens, formatUsd } from "./usageFormat";

describe("formatTokens", () => {
  it("formats under 1k", () => {
    expect(formatTokens(804)).toBe("804");
  });
  it("formats K", () => {
    expect(formatTokens(1500)).toBe("1.50K");
  });
  it("formats M with trim", () => {
    expect(formatTokens(1_900_000)).toBe("1.90M");
    expect(formatTokens(19_900_000_000)).toBe("19.9B");
  });
  it("formats T", () => {
    expect(formatTokens(1.2e12)).toBe("1.20T");
  });
  it("handles negative", () => {
    expect(formatTokens(-1500)).toBe("-1.50K");
  });
});

describe("formatUsd", () => {
  it("formats currency", () => {
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});

describe("formatCount", () => {
  it("rounds and formats", () => {
    expect(formatCount(1234.6)).toBe("1,235");
  });
});

describe("formatPercent", () => {
  it("formats share", () => {
    expect(formatPercent(0.1234)).toBe("12.3%");
  });
});
