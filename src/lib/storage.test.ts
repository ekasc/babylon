// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearStorageCache,
  getNumberWithFallback,
  getWithFallback,
  removeWithFallback,
  setWithFallback,
} from "./storage";

describe("storage cache", () => {
  beforeEach(() => {
    localStorage.clear();
    clearStorageCache();
  });

  it("falls back from babylon to pideck keys", () => {
    localStorage.setItem("pideck:foo", "legacy");
    expect(getWithFallback("foo")).toBe("legacy");
  });

  it("reads through to writes made via setWithFallback", () => {
    setWithFallback("theme", "dark");
    expect(getWithFallback("theme")).toBe("dark");
    setWithFallback("theme", "light");
    expect(getWithFallback("theme")).toBe("light");
  });

  it("does not serve a stale value after removeWithFallback", () => {
    setWithFallback("theme", "dark");
    removeWithFallback("theme");
    expect(getWithFallback("theme")).toBeNull();
  });

  it("removeWithFallback does not resurrect legacy pideck values", () => {
    localStorage.setItem("pideck:theme", "dark");
    setWithFallback("theme", "light");
    expect(getWithFallback("theme")).toBe("light");
    removeWithFallback("theme");
    expect(getWithFallback("theme")).toBeNull();
  });

  it("parses numbers with fallback", () => {
    setWithFallback("context-width", "520");
    expect(getNumberWithFallback("context-width", 999)).toBe(520);
    expect(getNumberWithFallback("missing", 999)).toBe(999);
  });
});
