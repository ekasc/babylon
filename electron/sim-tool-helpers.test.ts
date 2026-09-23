import { describe, expect, it } from "vitest";
import {
  PRESET_IDS,
  checkPreset,
  emulateResult,
  formatTabList,
  parseReviewSelector,
  parseReviewViewports,
  parseTabArg,
  parseTabArgOptional,
  requireSelector,
  requireTabId,
  requireUrl,
  reuseTabId,
  reviewSummary,
  snapshotBody,
  textResult,
} from "./sim-tool-helpers";

describe("browser tool arg helpers", () => {
  it("requires a URL with the tool's error", () => {
    expect(requireUrl({ url: "  https://a.dev " }, "browser_open")).toBe("https://a.dev");
    expect(() => requireUrl({}, "browser_open")).toThrow("browser_open: url is required");
    expect(() => requireUrl({ url: "   " }, "browser_navigate")).toThrow("browser_navigate: url is required");
  });

  it("requires a selector with the tool's error", () => {
    expect(requireSelector({ selector: "button.x" }, "browser_click")).toBe("button.x");
    expect(() => requireSelector({}, "browser_click")).toThrow("browser_click: selector is required");
  });

  it("requires a tab id for activation", () => {
    expect(requireTabId({ tab: "tab-1" })).toBe("tab-1");
    expect(() => requireTabId({})).toThrow("browser_activate_tab: tab is required");
    expect(() => requireTabId({ tab: "  " })).toThrow("browser_activate_tab: tab is required");
  });

  it("parses optional tab args (null vs undefined defaults)", () => {
    expect(parseTabArg({ tab: "t1" })).toBe("t1");
    expect(parseTabArg({})).toBeNull();
    expect(parseTabArg({ tab: "" })).toBeNull();
    expect(parseTabArg({ tab: 42 })).toBeNull();
    expect(parseTabArgOptional({ tab: "t1" })).toBe("t1");
    expect(parseTabArgOptional({})).toBeUndefined();
  });

  it("reuses the active tab unless newTab", () => {
    expect(reuseTabId("a", undefined)).toBe("a");
    expect(reuseTabId("a", true)).toBeUndefined();
    expect(reuseTabId(null, undefined)).toBeUndefined();
  });

  it("validates presets against the registry", () => {
    const first = PRESET_IDS[0];
    expect(checkPreset(first)).toBe(first);
    expect(() => checkPreset("nope")).toThrow("unknown preset nope");
    expect(() => checkPreset(undefined)).toThrow("unknown preset (missing)");
  });

  it("formats the tab list like browser_list_tabs", () => {
    expect(formatTabList([], null)).toBe("No browser tabs open.");
    expect(
      formatTabList(
        [
          { id: "a", url: "https://a.dev", title: "A" },
          { id: "b", url: "https://b.dev", title: null },
        ],
        "b"
      )
    ).toBe("○ a — A · https://a.dev\n● b — (no title) · https://b.dev");
  });

  it("labels emulation results with landscape suffix", () => {
    const firstPreset = PRESET_IDS[0];
    if (firstPreset === undefined) throw new Error("missing preset");
    expect(emulateResult(firstPreset, false)).toMatch(/^Emulating /);
    expect(emulateResult("unknown-preset", true)).toBe("Emulating unknown-preset (landscape)");
  });

  it("builds snapshot bodies with and without the ref tree", () => {
    const base = { url: "https://a.dev", title: "", text: "", a11y: "" };
    expect(snapshotBody(base)).toContain("(none)");
    expect(snapshotBody({ ...base, title: "T", text: "hi", a11y: "[1] button" })).toContain('ref:N');
  });

  it("wraps plain text results", () => {
    expect(textResult("hi")).toEqual({ content: [{ type: "text", text: "hi" }], details: { text: "hi" } });
  });

  it("defaults review viewports to mobile + desktop", () => {
    expect(parseReviewViewports(undefined)).toEqual([
      { preset: "iphone", rotated: false },
      { preset: "chrome-laptop", rotated: false },
    ]);
    expect(parseReviewViewports(null)).toHaveLength(2);
  });

  it("validates custom review viewports", () => {
    expect(parseReviewViewports([{ preset: "pixel", rotated: true }])).toEqual([
      { preset: "pixel", rotated: true },
    ]);
    expect(() => parseReviewViewports([])).toThrow("non-empty array");
    expect(() => parseReviewViewports("iphone")).toThrow("non-empty array");
    expect(() => parseReviewViewports([{ preset: "nope" }])).toThrow("unknown preset nope");
    expect(() => parseReviewViewports([{ rotated: true }])).toThrow("unknown preset (missing)");
    expect(() => parseReviewViewports([null])).toThrow("each viewport needs a preset");
    expect(() =>
      parseReviewViewports([
        { preset: "iphone" },
        { preset: "pixel" },
        { preset: "ipad" },
        { preset: "chrome-laptop" },
        { preset: "pixel" },
      ])
    ).toThrow("at most 4 viewports");
  });

  it("parses the optional review ready selector", () => {
    expect(parseReviewSelector(undefined)).toBeUndefined();
    expect(parseReviewSelector("  #app ")).toBe("#app");
    expect(() => parseReviewSelector("")).toThrow("readySelector");
    expect(() => parseReviewSelector(42)).toThrow("readySelector");
  });

  it("summarizes a review bundle in one line", () => {
    const line = reviewSummary("https://a.dev", [{ viewport: "V", width: 100, height: 200 }], 3, 500);
    expect(line).toContain("https://a.dev");
    expect(line).toContain("1 viewport(s)");
    expect(line).toContain("3 error(s)");
  });
});
