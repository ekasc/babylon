import { describe, expect, it } from "vitest";
import {
  BUILT_IN_THEME_IDS,
  MOBILE_DEFAULT_THEME_ID,
  RESERVED_THEME_IDS,
  UNPUBLISHABLE_THEME_IDS,
} from "./themePalettes";

describe("themePalettes", () => {
  it("contains built-ins", () => {
    expect(BUILT_IN_THEME_IDS).toContain("grove");
  });
  it("reserves system", () => {
    expect(RESERVED_THEME_IDS.has("system")).toBe(true);
    expect(RESERVED_THEME_IDS.has("my-custom")).toBe(false);
  });
  it("unpublishable includes mobile default", () => {
    expect(UNPUBLISHABLE_THEME_IDS.has(MOBILE_DEFAULT_THEME_ID)).toBe(true);
  });
});
