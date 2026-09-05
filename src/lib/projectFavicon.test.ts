import { describe, expect, it } from "vitest";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
  PROJECT_FAVICON_FALLBACK_MARKER,
} from "./projectFavicon";

describe("projectFavicon", () => {
  it("builds cache key", () => {
    expect(getProjectFaviconCacheKey("env1", "/ws", "https://cdn/x.png")).toBe(JSON.stringify(["env1", "/ws", "x.png"]));
  });
  it("detects fallback", () => {
    expect(isProjectFaviconFallbackUrl(`https://cdn/${PROJECT_FAVICON_FALLBACK_MARKER}`)).toBe(true);
    expect(isProjectFaviconFallbackUrl("https://cdn/x.png")).toBe(false);
    expect(isProjectFaviconFallbackUrl(null)).toBe(false);
  });
});
