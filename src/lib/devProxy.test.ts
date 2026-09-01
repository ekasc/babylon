import { describe, expect, it } from "vitest";
import { isDevProxiedPath } from "./devProxy";

describe("isDevProxiedPath", () => {
  it("matches prefixes", () => {
    expect(isDevProxiedPath("/api")).toBe(true);
    expect(isDevProxiedPath("/api/foo")).toBe(true);
    expect(isDevProxiedPath("/ws")).toBe(true);
  });
  it("rejects non-proxied", () => {
    expect(isDevProxiedPath("/")).toBe(false);
    expect(isDevProxiedPath("/index.html")).toBe(false);
  });
});
