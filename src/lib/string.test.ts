import { describe, expect, it } from "vitest";
import { truncate } from "./string";

describe("truncate", () => {
  it("returns trimmed when under limit", () => {
    expect(truncate("  hello  ")).toBe("hello");
  });
  it("truncates with ellipsis", () => {
    expect(truncate("hello world", 5)).toBe("hello...");
  });
  it("uses default 50", () => {
    expect(truncate("a".repeat(51))).toBe(`${"a".repeat(50)}...`);
  });
});
