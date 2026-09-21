export type SimKind = "browser" | "mobile";
export type SimChrome = "chrome" | "safari" | "firefox" | "notch" | "hole" | "bezel";

export interface SimPreset {
  id: string;
  label: string;
  kind: SimKind;
  /** CSS px viewport. */
  width: number;
  height: number;
  chrome: SimChrome;
  rotatable: boolean;
  /** Real device pixel ratio, applied via CDP. */
  dpr: number;
  /** Sent as the guest's user agent via CDP. Engine stays Chromium. */
  ua: string;
  /** Mobile viewport behavior + touch event emulation via CDP. */
  mobile: boolean;
  touch: boolean;
}

/**
 * Simulation presets. Rendering is real: the guest viewport is sized to the
 * device CSS px, deviceScaleFactor drives DPR-correct output, and the device
 * UA is what servers see. The JS engine stays Chromium throughout.
 */
export const SIM_PRESETS: SimPreset[] = [
  {
    id: "chrome-laptop", label: "Chrome · Laptop 1440×900", kind: "browser",
    width: 1440, height: 900, chrome: "chrome", rotatable: false, dpr: 2, mobile: false, touch: false,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  },
  {
    id: "safari-laptop", label: "Safari · Laptop 1440×900", kind: "browser",
    width: 1440, height: 900, chrome: "safari", rotatable: false, dpr: 2, mobile: false, touch: false,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  },
  {
    id: "firefox-desktop", label: "Firefox · Desktop 1512×945", kind: "browser",
    width: 1512, height: 945, chrome: "firefox", rotatable: false, dpr: 2, mobile: false, touch: false,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:139.0) Gecko/20100101 Firefox/139.0",
  },
  {
    id: "iphone", label: "iPhone 15 Pro · 393×852", kind: "mobile",
    width: 393, height: 852, chrome: "notch", rotatable: true, dpr: 3, mobile: true, touch: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  },
  {
    id: "pixel", label: "Pixel 9 · 412×915", kind: "mobile",
    width: 412, height: 915, chrome: "hole", rotatable: true, dpr: 2.625, mobile: true, touch: true,
    ua: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
  },
  {
    id: "android-small", label: "Android small · 360×800", kind: "mobile",
    width: 360, height: 800, chrome: "hole", rotatable: true, dpr: 2, mobile: true, touch: true,
    ua: "Mozilla/5.0 (Linux; Android 15; moto g) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
  },
  {
    id: "ipad", label: "iPad Air · 820×1180", kind: "mobile",
    width: 820, height: 1180, chrome: "bezel", rotatable: true, dpr: 2, mobile: true, touch: true,
    ua: "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  },
];

export function findPreset(id: string): SimPreset {
  const fallback = SIM_PRESETS[0];
  if (fallback === undefined) throw new Error("no simulator presets");
  return SIM_PRESETS.find((p) => p.id === id) ?? fallback;
}

/** CDP Emulation payload the main process applies to the sim guest. */
export interface SimEmulation {
  viewportW: number;
  viewportH: number;
  dpr: number;
  mobile: boolean;
  ua: string;
  touch: boolean;
  orientation: "portrait" | "landscape";
}

/** Resolve a preset (+ rotation) to validated CDP emulation parameters. */
export function buildEmulation(presetId: string, rotated: boolean): SimEmulation {
  const p = findPreset(presetId);
  const landscape = p.rotatable && rotated;
  const viewportW = landscape ? p.height : p.width;
  const viewportH = landscape ? p.width : p.height;
  return {
    viewportW,
    viewportH,
    dpr: p.dpr,
    mobile: p.mobile,
    ua: p.ua,
    touch: p.touch,
    orientation: viewportW > viewportH ? "landscape" : "portrait",
  };
}

/** Match a live emulation back to its preset (for adopting agent-driven state). */
export function matchPreset(e: SimEmulation): { presetId: string; rotated: boolean } | null {
  for (const p of SIM_PRESETS) {
    for (const rotated of p.rotatable ? [false, true] : [false]) {
      const b = buildEmulation(p.id, rotated);
      if (
        b.viewportW === e.viewportW &&
        b.viewportH === e.viewportH &&
        b.dpr === e.dpr &&
        b.mobile === e.mobile &&
        b.ua === e.ua &&
        b.touch === e.touch
      ) {
        return { presetId: p.id, rotated };
      }
    }
  }
  return null;
}

/** Viewport mode: fill follows the panel 1:1, freeform pins exact dimensions,
 * preset sizes to a named device. Adapted from t3code's preview viewport
 * model (MIT, T3 Tools Inc): fill is the default, emulation is opt-in. */
export type SimViewportMode = "fill" | "freeform" | "preset";
export type SimViewport =
  | { mode: "fill" }
  | { mode: "freeform"; width: number; height: number }
  | { mode: "preset"; presetId: string; rotated: boolean };

export const SIM_VIEWPORT_MIN = 200;
export const SIM_VIEWPORT_MAX = 4000;

/** Default desktop UA used for fill/freeform (no device impersonation). */
export const SIM_DESKTOP_UA = SIM_PRESETS[0]?.ua ?? "";

/** Resolve a viewport to CDP emulation, or null for fill (clear overrides). */
export function resolveViewport(v: SimViewport): SimEmulation | null {
  if (v.mode === "fill") return null;
  if (v.mode === "freeform") {
    const width = Math.round(v.width);
    const height = Math.round(v.height);
    return {
      viewportW: width,
      viewportH: height,
      dpr: 1,
      mobile: false,
      ua: SIM_DESKTOP_UA,
      touch: false,
      orientation: width > height ? "landscape" : "portrait",
    };
  }
  return buildEmulation(v.presetId, v.rotated);
}

/** Match live emulation back to a viewport (for adopting agent-driven state). */
export function matchViewport(e: SimEmulation | null): SimViewport {
  if (!e) return { mode: "fill" };
  const preset = matchPreset(e);
  if (preset) return { mode: "preset", presetId: preset.presetId, rotated: preset.rotated };
  return { mode: "freeform", width: e.viewportW, height: e.viewportH };
}

/** Guard IPC input: fill/freeform/preset with sane dimensions. Null when invalid. */
export function sanitizeViewport(raw: unknown): SimViewport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.mode === "fill") return { mode: "fill" };
  if (r.mode === "freeform") {
    const width = Math.round(typeof r.width === "number" && Number.isFinite(r.width) ? r.width : NaN);
    const height = Math.round(typeof r.height === "number" && Number.isFinite(r.height) ? r.height : NaN);
    if (!(width >= SIM_VIEWPORT_MIN && width <= SIM_VIEWPORT_MAX && height >= SIM_VIEWPORT_MIN && height <= SIM_VIEWPORT_MAX)) return null;
    return { mode: "freeform", width, height };
  }
  if (r.mode === "preset") {
    if (typeof r.presetId !== "string" || !SIM_PRESETS.some((p) => p.id === r.presetId)) return null;
    return { mode: "preset", presetId: r.presetId, rotated: r.rotated === true };
  }
  return null;
}
/** Guard IPC input: finite numbers, sane ranges, capped UA. Null when invalid. */
export function sanitizeEmulation(raw: unknown): SimEmulation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const viewportW = Math.round(num(r.viewportW));
  const viewportH = Math.round(num(r.viewportH));
  const dpr = num(r.dpr);
  if (!(viewportW >= 200 && viewportW <= 4000 && viewportH >= 200 && viewportH <= 4000)) return null;
  if (!(dpr >= 1 && dpr <= 4)) return null;
  if (typeof r.ua !== "string" || !r.ua.trim() || r.ua.length > 500) return null;
  return {
    viewportW,
    viewportH,
    dpr,
    mobile: r.mobile === true,
    ua: r.ua,
    touch: r.touch === true,
    orientation: r.orientation === "landscape" ? "landscape" : "portrait",
  };
}

/** Guard IPC input: http(s) URLs only. Null when invalid.
 * Schemaless input ("example.com") gets https:// prepended, like a browser omnibox. */
export function sanitizeSimUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim();
  if (!clean || clean.length > 2048) return null;
  // Explicit URL first. A scheme-like prefix without "://" may be host:port
  // ("localhost:3000" parses as scheme "localhost:"), so only an explicit
  // scheme:// URL is rejected here; the rest falls through to prepending.
  try {
    const parsed = new URL(clean);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
    if (clean.includes("://")) return null;
  } catch {
    // Not a full URL ("google.com") — fall through and prepend.
  }
  const host = clean.split(/[/?#]/, 1)[0] ?? clean;
  const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? "http" : "https";
  try {
    const parsed = new URL(`${scheme}://${clean}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Guard IPC input: window-content DIP rect. Null when invalid. */
export function sanitizeSimBounds(raw: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN);
  const x = int(r.x);
  const y = int(r.y);
  const width = int(r.width);
  const height = int(r.height);
  if (!(x >= 0 && y >= 0 && width >= 50 && width <= 5000 && height >= 50 && height <= 5000)) return null;
  return { x, y, width, height };
}

/** Scale factor so a vw×vh viewport fits maxW×maxH (never upscale past 1). */
export function simFitScale(vw: number, vh: number, maxW: number, maxH: number): number {
  if (vw <= 0 || vh <= 0 || maxW <= 0 || maxH <= 0) return 1;
  return Math.min(1, maxW / vw, maxH / vh);
}

/** Clamp a page zoom factor the way Chromium does (25%–500%). */
export function normalizeZoomFactor(raw: unknown): number {
  const f = typeof raw === "number" && Number.isFinite(raw) ? raw : NaN;
  if (!f || f <= 0) return 1;
  return Math.min(5, Math.max(0.25, Math.round(f * 100) / 100));
}

/** Effective page zoom: user zoom (⋮ menu) times the panel's fit factor.
 * A CDP device-metrics override only changes the LAYOUT viewport — Chromium
 * clips it to the window. The fit factor compensates so an emulated viewport
 * actually fits its slot. Fit never upscales; the product is floored so a
 * narrow pane + wide preset degrades to a small crop, not garbage. */
export function effectiveZoom(userZoom: number, fitZoom: number): number {
  const u = typeof userZoom === "number" && Number.isFinite(userZoom) && userZoom > 0 ? userZoom : 1;
  const f = typeof fitZoom === "number" && Number.isFinite(fitZoom) && fitZoom > 0 ? Math.min(1, fitZoom) : 1;
  return Math.max(0.05, Math.round(u * f * 1000) / 1000);
}

const KEY = "babylon:simulator:v1";

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): Store | null {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      const storage = (globalThis as { localStorage?: unknown }).localStorage;
      const store = storage as { getItem?: unknown; setItem?: unknown } | null | undefined;
      if (typeof store?.getItem === "function" && typeof store?.setItem === "function") {
        const getItem = store.getItem.bind(storage);
        const setItem = store.setItem.bind(storage);
        return {
          getItem: (key: string) => {
            const value = getItem(key) as unknown;
            return typeof value === "string" ? value : null;
          },
          setItem: (key: string, value: string) => {
            setItem(key, value);
          },
        };
      }
    }
  } catch {
    /* storage unavailable */
  }
  return null;
}

export interface SimPrefs {
  presetId: string;
  rotated: boolean;
  deviceToolbar: boolean;
}

export function loadSimPrefs(store: Store | null = defaultStore()): SimPrefs {
  const fallback: SimPrefs = { presetId: SIM_PRESETS[0]?.id ?? "desktop", rotated: false, deviceToolbar: false };
  if (!store) return fallback;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SimPrefs>;
    const presetId = typeof parsed.presetId === "string" && SIM_PRESETS.some((p) => p.id === parsed.presetId)
      ? parsed.presetId
      : fallback.presetId;
    const rotated = parsed.rotated === true;
    const deviceToolbar = parsed.deviceToolbar === true;
    return { presetId, rotated, deviceToolbar };
  } catch {
    return fallback;
  }
}

export function saveSimPrefs(prefs: SimPrefs, store: Store | null = defaultStore()): void {
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* quota or unavailable: prefs stay in memory */
  }
}
