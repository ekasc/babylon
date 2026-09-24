import type { PiSettings } from "./settings-shared";
import { isPlainObject } from "./wire";

function isModelRef(value: unknown): value is NonNullable<PiSettings["chatModel"]> {
  if (!isPlainObject(value)) return false;
  return typeof value.provider === "string" && typeof value.modelId === "string";
}

/**
 * Narrow an untrusted settings patch to the PiSettings shape before it
 * reaches persistence. Unknown keys are dropped; mistyped values throw.
 * Shared by the daemon socket boundary and settings-file import.
 */
export function toSettingsPatch(patch: unknown): Partial<PiSettings> {
  if (!isPlainObject(patch)) throw new Error("settings patch must be an object");
  const out: Partial<PiSettings> = {};
  const takeModel = (key: "chatModel" | "imageModel" | "titleModel" | "gitCommitModel") => {
    const v = patch[key];
    if (v !== undefined) {
      if (!isModelRef(v)) throw new Error(`settings patch: ${key} must be { provider, modelId }`);
      out[key] = { provider: v.provider, modelId: v.modelId };
    }
  };
  takeModel("chatModel");
  takeModel("imageModel");
  takeModel("titleModel");
  takeModel("gitCommitModel");
  const takeString = (key: "chatReasoning" | "titleReasoning" | "gitCommitPrompt") => {
    const v = patch[key];
    if (v !== undefined) {
      if (typeof v !== "string") throw new Error(`settings patch: ${key} must be a string`);
      out[key] = v;
    }
  };
  takeString("chatReasoning");
  takeString("titleReasoning");
  takeString("gitCommitPrompt");
  if (patch.contextWindowOverrides !== undefined) {
    const v = patch.contextWindowOverrides;
    if (!isPlainObject(v)) throw new Error("settings patch: contextWindowOverrides must be an object");
    const overrides: Record<string, number> = {};
    for (const [k, n] of Object.entries(v)) {
      if (typeof n !== "number") throw new Error("settings patch: contextWindowOverrides must be Record<string, number>");
      overrides[k] = n;
    }
    out.contextWindowOverrides = overrides;
  }
  if (patch.appearance !== undefined) {
    const v = patch.appearance;
    if (!isPlainObject(v)) throw new Error("settings patch: appearance must be an object");
    const theme = v.theme;
    if (theme !== undefined && theme !== "light" && theme !== "dark" && theme !== "system") {
      throw new Error("settings patch: appearance.theme must be light, dark, or system");
    }
    out.appearance = {
      ...(typeof theme === "string" ? { theme } : {}),
      ...(typeof v.useSystemFonts === "boolean" ? { useSystemFonts: v.useSystemFonts } : {}),
      ...(typeof v.monoFontFamily === "string" ? { monoFontFamily: v.monoFontFamily } : {}),
    };
  }
  if (patch.compaction !== undefined) {
    const v = patch.compaction;
    if (!isPlainObject(v)) throw new Error("settings patch: compaction must be an object");
    const mode = v.mode;
    if (mode !== undefined && mode !== "automatic" && mode !== "summary" && mode !== "snapcompact") {
      throw new Error("settings patch: compaction.mode must be automatic, summary, or snapcompact");
    }
    out.compaction = mode === "automatic" || mode === "summary" || mode === "snapcompact" ? { mode } : {};
  }
  if (patch.daemon !== undefined) {
    const v = patch.daemon;
    if (!isPlainObject(v)) throw new Error("settings patch: daemon must be an object");
    out.daemon = typeof v.enabled === "boolean" ? { enabled: v.enabled } : {};
  }
  return out;
}
