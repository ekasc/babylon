import { describe, expect, it } from "vitest";
import {
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "./path";

describe("path", () => {
  it("detects windows drive", () => {
    expect(isWindowsDrivePath("C:\\")).toBe(true);
    expect(isWindowsDrivePath("C:/")).toBe(true);
    expect(isWindowsDrivePath("/usr")).toBe(false);
  });
  it("detects unc", () => {
    expect(isUncPath("\\\\server\\share")).toBe(true);
  });
  it("detects explicit relative", () => {
    expect(isExplicitRelativePath("./foo")).toBe(true);
    expect(isExplicitRelativePath("foo")).toBe(false);
  });
  it("trims trailing separators", () => {
    expect(normalizeProjectPathForDispatch("/foo/bar/")).toBe("/foo/bar");
    expect(normalizeProjectPathForDispatch("C:\\foo\\")).toBe("C:\\foo");
  });
  it("normalizes for comparison case-insensitive on windows", () => {
    expect(normalizeProjectPathForComparison("C:\\Foo\\Bar")).toBe("c:\\foo\\bar");
    expect(normalizeProjectPathForComparison("/foo/bar/")).toBe("/foo/bar");
  });
  it("isWindowsAbsolute", () => {
    expect(isWindowsAbsolutePath("\\\\a\\b")).toBe(true);
    expect(isWindowsAbsolutePath("C:")).toBe(true);
    expect(isWindowsAbsolutePath("/a")).toBe(false);
  });
});
