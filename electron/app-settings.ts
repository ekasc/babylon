import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_GIT_COMMIT_MODEL,
  DEFAULT_GIT_COMMIT_PROMPT,
  type ModelRef,
  type PiSettings,
} from "../src/lib/settings-shared";

export type { ModelRef, PiSettings } from "../src/lib/settings-shared";
export { DEFAULT_CHAT_MODEL, DEFAULT_GIT_COMMIT_MODEL, DEFAULT_GIT_COMMIT_PROMPT };

const EMPTY: PiSettings = {
  contextWindowOverrides: {},
  chatModel: DEFAULT_CHAT_MODEL,
  chatReasoning: "off",
  titleModel: DEFAULT_GIT_COMMIT_MODEL,
  titleReasoning: "low",
  gitCommitModel: DEFAULT_GIT_COMMIT_MODEL,
  gitCommitPrompt: DEFAULT_GIT_COMMIT_PROMPT,
  appearance: { theme: "system", useSystemFonts: true, monoFontFamily: "system" },
  compaction: { mode: "summary" },
  daemon: {},
};

export const SETTINGS_VERSION = 1;

let cache: PiSettings | null = null;

function settingsPath(): string {
  if (process.env.BABYLON_SETTINGS_PATH) return process.env.BABYLON_SETTINGS_PATH;
  try {
    const { app } = require("electron") as typeof import("electron");
    if (app && typeof app.getPath === "function") {
      return join(app.getPath("userData"), "pideck-settings.json");
    }
  } catch {}
  const base = join(homedir(), ".babylon", "pideck-settings.json");
  return base;
}

/** Read the current settings (cached; reads disk once). */
export function getSettings(): PiSettings {
  if (cache) return cache;
  try {
    const path = settingsPath();
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PiSettings>;
      cache = {
        ...EMPTY,
        ...parsed,
        contextWindowOverrides: parsed.contextWindowOverrides ?? {},
        appearance: { ...EMPTY.appearance, ...(parsed.appearance ?? {}) },
        compaction: { ...EMPTY.compaction, ...(parsed.compaction ?? {}) },
        daemon: { ...(EMPTY.daemon ?? {}), ...(parsed.daemon ?? {}) },
      };
      // migrate: theme previously only in localStorage; keep file default if missing
      if (!cache.appearance) cache.appearance = { ...EMPTY.appearance };
      return cache;
    }
  } catch {
    // Corrupt or unreadable file → fall back to defaults.
  }
  cache = { ...EMPTY };
  return cache;
}

/** Merge `patch` into the stored settings and persist atomically. Deep-merges known nested objects. */
export function saveSettings(patch: Partial<PiSettings>): PiSettings {
  const current = getSettings();
  const next: PiSettings = {
    ...current,
    ...patch,
    // deep-merge nested objects; if patch explicitly sets {} or undefined for a nested key, respect it
    contextWindowOverrides: patch.contextWindowOverrides !== undefined
      ? { ...(patch.contextWindowOverrides ?? {}) }
      // preserve full replacement when caller passes the computed map directly (common path) vs undefined
      : { ...(current.contextWindowOverrides ?? {}) },
    appearance: patch.appearance !== undefined
      ? { ...(current.appearance ?? {}), ...(patch.appearance ?? {}) }
      : { ...(current.appearance ?? {}) },
    compaction: patch.compaction !== undefined
      ? { ...(current.compaction ?? {}), ...(patch.compaction ?? {}) }
      : { ...(current.compaction ?? {}) },
    daemon: patch.daemon !== undefined
      ? { ...(current.daemon ?? {}), ...(patch.daemon ?? {}) }
      : { ...(current.daemon ?? {}) },
  };
  // When caller passes contextWindowOverrides they intend full replacement (see Settings UI). Detect that case:
  if (patch.contextWindowOverrides !== undefined) {
    next.contextWindowOverrides = { ...(patch.contextWindowOverrides ?? {}) };
  }
  // Handle explicit null-style resets for model refs
  if ("chatModel" in patch) next.chatModel = patch.chatModel;
  if ("titleModel" in patch) next.titleModel = patch.titleModel;
  if ("gitCommitModel" in patch) next.gitCommitModel = patch.gitCommitModel;
  cache = next;
  try {
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    throw new Error(`Failed to persist settings: ${e instanceof Error ? e.message : String(e)}`);
  }
  return next;
}

export function resetSettings(): PiSettings {
  cache = { ...EMPTY, contextWindowOverrides: {}, appearance: { ...EMPTY.appearance! }, compaction: { ...EMPTY.compaction! }, daemon: {} };
  try {
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2), "utf8");
  } catch {}
  return cache!;
}

export function getSettingsPath(): string {
  return settingsPath();
}

export function validateImportedSettings(data: unknown): { ok: true; value: PiSettings } | { ok: false; error: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "Settings must be an object" };
  const obj = data as Record<string, unknown>;
  const allowed = new Set(["chatModel", "chatReasoning", "titleModel", "titleReasoning", "gitCommitModel", "gitCommitPrompt", "contextWindowOverrides", "appearance", "compaction", "daemon"]);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) return { ok: false, error: `Unknown key: ${k}` };
  // shallow type checks
  if (obj.contextWindowOverrides !== undefined) {
    if (typeof obj.contextWindowOverrides !== "object" || Array.isArray(obj.contextWindowOverrides)) return { ok: false, error: "contextWindowOverrides must be an object" };
    for (const [k, v] of Object.entries(obj.contextWindowOverrides as Record<string, unknown>)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return { ok: false, error: `Invalid contextWindow override for ${k}` };
    }
  }
  return { ok: true, value: obj as PiSettings };
}
