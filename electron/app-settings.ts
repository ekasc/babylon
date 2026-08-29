import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
  /** Model used to generate commit messages for the Git quick action. */
  gitCommitModel?: ModelRef;
  /** User-editable instructions appended to Babylon's built-in Unslop rules. */
  gitCommitPrompt?: string;
  /**
   * Per-model context-window overrides, keyed by "provider/model".
   * Only present when the user has customized a model's window.
   */
  contextWindowOverrides?: Record<string, number>;
  /**
   * Babylon daemon (Phase 6). When enabled, the desktop spawns the standalone
   * daemon process at startup and leaves it running after the GUI closes, so
   * background execution survives the window.
   */
  daemon?: {
    enabled?: boolean;
  };
  /** Appearance preferences. */
  appearance?: {
    useSystemFonts?: boolean;
    /** Selected monospace font for inline code and blocks. "system" = ui-monospace stack. */
    monoFontFamily?: string;
  };
}

export const DEFAULT_GIT_COMMIT_MODEL: ModelRef = {
  provider: "opencode-go",
  modelId: "muse-spark-1.2-contributor",
};

export const DEFAULT_CHAT_MODEL: ModelRef = {
  provider: "opencode-go",
  modelId: "muse-spark-1.2-contributor",
};

export const DEFAULT_GIT_COMMIT_PROMPT =
  "Describe the primary change and why it matters. Follow the repository's existing commit style when the recent history makes it clear.";

const EMPTY: PiSettings = {
  contextWindowOverrides: {},
  chatModel: DEFAULT_CHAT_MODEL,
  titleModel: DEFAULT_GIT_COMMIT_MODEL,
  gitCommitModel: DEFAULT_GIT_COMMIT_MODEL,
  gitCommitPrompt: DEFAULT_GIT_COMMIT_PROMPT,
  appearance: { useSystemFonts: true, monoFontFamily: "system" },
};

let cache: PiSettings | null = null;

function settingsPath(): string {
  try {
    const { app } = require("electron") as typeof import("electron");
    if (app && typeof app.getPath === "function") {
      return join(app.getPath("userData"), "pideck-settings.json");
    }
  } catch {}
  const base = process.env.BABYLON_SETTINGS_PATH ?? join(homedir(), ".babylon", "pideck-settings.json");
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
    appearance: {
      ...(current.appearance ?? {}),
      ...(patch.appearance ?? {}),
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
