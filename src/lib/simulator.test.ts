import { describe, expect, it } from "vitest";
import {
  SIM_PRESETS,
  buildEmulation,
  effectiveZoom,
  findPreset,
  loadSimPrefs,
  matchPreset,
  matchViewport,
  normalizeZoomFactor,
  resolveViewport,
  sanitizeEmulation,
  sanitizeSimBounds,
  sanitizeSimUrl,
  sanitizeViewport,
  saveSimPrefs,
  simFitScale,
} from "./simulator";

const memStore = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

describe("SIM_PRESETS", () => {
  it("has unique ids, positive viewports, and both kinds", () => {
    const ids = SIM_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of SIM_PRESETS) {
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
    }
    expect(SIM_PRESETS.some((p) => p.kind === "browser")).toBe(true);
    expect(SIM_PRESETS.some((p) => p.kind === "mobile")).toBe(true);
  });
  it("falls back to the first preset for unknown ids", () => {
    expect(findPreset("nope")).toBe(SIM_PRESETS[0]);
    expect(findPreset("iphone").width).toBe(393);
  });
});

describe("simFitScale", () => {
  it("fits without upscaling", () => {
    expect(simFitScale(1440, 900, 720, 450)).toBeCloseTo(0.5);
    expect(simFitScale(393, 852, 2000, 2000)).toBe(1);
    expect(simFitScale(0, 0, 100, 100)).toBe(1);
  });
});

describe("normalizeZoomFactor", () => {
  it("clamps to Chromium's 25%–500% range", () => {
    expect(normalizeZoomFactor(1)).toBe(1);
    expect(normalizeZoomFactor(0.1)).toBe(0.25);
    expect(normalizeZoomFactor(9)).toBe(5);
    expect(normalizeZoomFactor("x")).toBe(1);
    expect(normalizeZoomFactor(1.234)).toBe(1.23);
  });
});

describe("effectiveZoom", () => {
  it("multiplies user zoom by the fit factor without upscaling", () => {
    // 1440px preset in a ~705px slot: the page must shrink to fit.
    expect(effectiveZoom(1, 705 / 1440)).toBeCloseTo(0.49, 2);
    expect(effectiveZoom(2, 0.49)).toBeCloseTo(0.98, 2);
    expect(effectiveZoom(1, 1)).toBe(1);
    // Fit never upscales a small preset into a big stage.
    expect(effectiveZoom(1, 2)).toBe(1);
    // Garbage in, sane out.
    expect(effectiveZoom(NaN, 0.5)).toBe(0.5);
    expect(effectiveZoom(1, 0)).toBe(1);
  });
});

describe("buildEmulation", () => {
  it("resolves real device parameters and rotation", () => {
    const phone = buildEmulation("iphone", false);
    expect(phone).toMatchObject({ viewportW: 393, viewportH: 852, dpr: 3, mobile: true, touch: true, orientation: "portrait" });
    expect(phone.ua).toContain("iPhone");
    const rotated = buildEmulation("iphone", true);
    expect(rotated).toMatchObject({ viewportW: 852, viewportH: 393, orientation: "landscape" });
    const desktop = buildEmulation("chrome-laptop", false);
    expect(desktop).toMatchObject({ viewportW: 1440, viewportH: 900, dpr: 2, mobile: false, touch: false });
    expect(desktop.ua).toContain("Chrome");
    // Non-rotatable presets ignore rotation.
    expect(buildEmulation("chrome-laptop", true).viewportW).toBe(1440);
  });

  it("throws on unknown presets instead of emulating the wrong device", () => {
    expect(() => buildEmulation("nope", false)).toThrow("unknown preset nope");
  });
});

describe("matchPreset", () => {
  it("round-trips emulation back to preset + rotation", () => {
    expect(matchPreset(buildEmulation("iphone", false))).toEqual({ presetId: "iphone", rotated: false });
    expect(matchPreset(buildEmulation("iphone", true))).toEqual({ presetId: "iphone", rotated: true });
    expect(matchPreset(buildEmulation("chrome-laptop", false))).toEqual({ presetId: "chrome-laptop", rotated: false });
    expect(matchPreset({ ...buildEmulation("iphone", false), viewportW: 123 })).toBeNull();
  });
});

describe("viewport modes", () => {
  it("fill resolves to null (clear overrides)", () => {
    expect(resolveViewport({ mode: "fill" })).toBeNull();
  });
  it("freeform resolves to a 1x desktop emulation", () => {
    expect(resolveViewport({ mode: "freeform", width: 1008, height: 756 })).toMatchObject({
      viewportW: 1008,
      viewportH: 756,
      dpr: 1,
      mobile: false,
      touch: false,
      orientation: "landscape",
    });
  });
  it("preset resolves through buildEmulation", () => {
    expect(resolveViewport({ mode: "preset", presetId: "iphone", rotated: false })).toMatchObject({
      viewportW: 393,
      viewportH: 852,
    });
  });
  it("matchViewport round-trips emulation", () => {
    expect(matchViewport(null)).toEqual({ mode: "fill" });
    expect(matchViewport(buildEmulation("iphone", true))).toEqual({ mode: "preset", presetId: "iphone", rotated: true });
    expect(matchViewport({ viewportW: 1008, viewportH: 756, dpr: 1, mobile: false, ua: "u", touch: false, orientation: "landscape" }))
      .toEqual({ mode: "freeform", width: 1008, height: 756 });
  });
  it("sanitizeViewport accepts the union and rejects garbage", () => {
    expect(sanitizeViewport({ mode: "fill" })).toEqual({ mode: "fill" });
    expect(sanitizeViewport({ mode: "freeform", width: 1008, height: 756 })).toEqual({ mode: "freeform", width: 1008, height: 756 });
    expect(sanitizeViewport({ mode: "freeform", width: 50, height: 756 })).toBeNull();
    expect(sanitizeViewport({ mode: "preset", presetId: "iphone", rotated: true })).toEqual({ mode: "preset", presetId: "iphone", rotated: true });
    expect(sanitizeViewport({ mode: "preset", presetId: "nope" })).toBeNull();
    expect(sanitizeViewport(null)).toBeNull();
    expect(sanitizeViewport({ mode: "weird" })).toBeNull();
  });
});

describe("sanitizers", () => {
  it("accepts valid emulation and rejects garbage", () => {
    const good = { viewportW: 393, viewportH: 852, dpr: 3, mobile: true, ua: "x", touch: true, orientation: "portrait" };
    expect(sanitizeEmulation(good)).toEqual({ ...good });
    expect(sanitizeEmulation(null)).toBeNull();
    expect(sanitizeEmulation({ ...good, viewportW: 50 })).toBeNull();
    expect(sanitizeEmulation({ ...good, dpr: 8 })).toBeNull();
    expect(sanitizeEmulation({ ...good, ua: "" })).toBeNull();
  });
  it("accepts http(s) URLs only", () => {
    expect(sanitizeSimUrl("http://localhost:5173/"))?.toContain("localhost");
    expect(sanitizeSimUrl("file:///etc/passwd")).toBeNull();
    expect(sanitizeSimUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeSimUrl(42)).toBeNull();
  });
  it("prepends a scheme for omnibox-style input", () => {
    expect(sanitizeSimUrl("googl.com")).toBe("https://googl.com/");
    expect(sanitizeSimUrl("google.com/search?q=x")).toBe("https://google.com/search?q=x");
    expect(sanitizeSimUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(sanitizeSimUrl("127.0.0.1:5173/app")).toBe("http://127.0.0.1:5173/app");
    expect(sanitizeSimUrl("not a url at all")).toBeNull();
  });
  it("accepts sane bounds only", () => {
    expect(sanitizeSimBounds({ x: 10, y: 20, width: 393, height: 852 })).toEqual({ x: 10, y: 20, width: 393, height: 852 });
    expect(sanitizeSimBounds({ x: -1, y: 0, width: 100, height: 100 })).toBeNull();
    expect(sanitizeSimBounds({ x: 0, y: 0, width: 10, height: 10 })).toBeNull();
  });
});

describe("sim prefs", () => {
  it("round-trips and rejects garbage", () => {
    const store = memStore();
    expect(loadSimPrefs(store)).toEqual({ presetId: (SIM_PRESETS[0]?.id ?? ""), rotated: false, deviceToolbar: false });
    saveSimPrefs({ presetId: "iphone", rotated: true, deviceToolbar: true }, store);
    expect(loadSimPrefs(store)).toEqual({ presetId: "iphone", rotated: true, deviceToolbar: true });
    const bad = memStore();
    bad.setItem("babylon:simulator:v1", "{nope");
    expect(loadSimPrefs(bad)).toEqual({ presetId: (SIM_PRESETS[0]?.id ?? ""), rotated: false, deviceToolbar: false });
    const wrong = memStore();
    wrong.setItem("babylon:simulator:v1", JSON.stringify({ presetId: "nope" }));
    expect(loadSimPrefs(wrong)?.presetId).toBe((SIM_PRESETS[0]?.id ?? ""));
  });
});
