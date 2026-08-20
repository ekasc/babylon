import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * User preferences owned by Babylon (distinct from pi's per-project settings).
 * Persisted as JSON in the app's userData dir so they survive restarts and are
 * shared across every project the user opens.
 */
export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface PiSettings {
  /** Default model used for the live chat. */
  chatModel?: ModelRef;
  /** Reasoning level applied alongside `chatModel`. */
  chatReasoning?: string;
  /** Model used for cheap, non-interactive work: session titles and recaps. */
  titleModel?: ModelRef;
  /** Reasoning level applied to title-generation calls. */
  titleReasoning?: string;
  /**
   * Per-model context-window overrides, keyed by "provider/model".
   * Only present when the user has customized a model's window.
   */
  contextWindowOverrides?: Record<string, number>;
}

const EMPTY: PiSettings = { contextWindowOverrides: {} };

let cache: PiSettings | null = null;

function settingsPath(): string {
  return join(app.getPath("userData"), "pideck-settings.json");
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
      };
      return cache;
    }
  } catch {
    // Corrupt or unreadable file → fall back to defaults.
  }
  cache = { ...EMPTY };
  return cache;
}

/** Merge `patch` into the stored settings and persist atomically. */
export function saveSettings(patch: Partial<PiSettings>): PiSettings {
  const current = getSettings();
  const next: PiSettings = {
    ...current,
    ...patch,
    contextWindowOverrides: {
      ...(current.contextWindowOverrides ?? {}),
      ...(patch.contextWindowOverrides ?? {}),
    },
  };
  cache = next;
  try {
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
  } catch {
    // Best-effort persistence: the in-memory cache still holds the new value.
  }
  return next;
}
