import { describe, expect, it } from "vitest";
import { compareSemverVersions, normalizeSemverVersion, parseSemver, satisfiesSemverRange } from "./semver";

describe("semver", () => {
  it("normalizes shorthand", () => {
    expect(normalizeSemverVersion("20")).toBe("20.0.0");
    expect(normalizeSemverVersion("20.1")).toBe("20.1.0");
  });
  it("parses", () => {
    expect(parseSemver("v1.2.3-alpha.1")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ["alpha", "1"] });
    expect(parseSemver("bad")).toBeNull();
  });
  it("compares", () => {
    expect(compareSemverVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareSemverVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });
  it("satisfies range", () => {
    expect(satisfiesSemverRange("1.2.3", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesSemverRange("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesSemverRange("1.5.0", "^1.0.0")).toBe(true);
  });
});
