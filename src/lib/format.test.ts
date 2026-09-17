import { describe, expect, it } from "vitest";
import { formatTokens } from "./format";

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
  it("handles missing input", () => {
    expect(formatTokens(undefined)).toBe("0");
  });
});
