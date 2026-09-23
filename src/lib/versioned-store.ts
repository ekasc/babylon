import { useState, type Dispatch, type SetStateAction } from "react";
import { getWithFallback, setWithFallback } from "./storage";

/**
 * Versioned persisted UI state.
 *
 * Every structured localStorage blob goes through here: reads parse,
 * validate, and migrate (corrupt or ancient data falls back instead of
 * throwing on a render path), writes go through one setter. Plain string
 * prefs stay in prefs.ts; this module is for shaped JSON (tabs, sidebar
 * shelves, spaces). Version 0 means "never versioned": the first read
 * validates the legacy shape and rewrites it stamped.
 */

export interface StoreDef<T> {
  /** Bare key; storage.ts applies the `babylon:` namespace. */
  key: string;
  version: number;
  fallback: () => T;
  /** True for loadable values (migrated or current). Never throws. */
  validate: (value: unknown) => value is T;
  /** Upgrade an older payload to the current shape. Receives anything that
   *  failed validation (legacy shapes included), so the input is unknown
   *  and the implementation must narrow defensively. */
  migrate?: (value: unknown, fromVersion: number) => T;
}

export function defineStore<T>(def: StoreDef<T>): StoreDef<T> {
  return def;
}

interface Stamped {
  version: number;
  value: unknown;
}

function isStamped(value: unknown): value is Stamped {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const version = (value as { version?: unknown }).version;
  return typeof version === "number" && Number.isInteger(version) && version >= 0 && "value" in value;
}

function devWarn(key: string, message: string): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[persisted-store] ${key}: ${message}`);
  }
}

export function readStore<T>(def: StoreDef<T>): T {
  let raw: string | null = null;
  try {
    raw = getWithFallback(def.key);
  } catch {
    return def.fallback();
  }
  if (raw == null) return def.fallback();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    devWarn(def.key, "corrupt JSON, falling back");
    return def.fallback();
  }
  // Stamped payloads carry their version; anything else is legacy v0.
  // NOTE: isStamped returns a boolean — the payload fields below are read
  // off `parsed` (narrowed in each branch), never off the guard result.
  if (isStamped(parsed)) {
    if (parsed.version === def.version) {
      if (def.validate(parsed.value)) return parsed.value;
      devWarn(def.key, "current version but unrecognised shape, falling back");
      return def.fallback();
    }
    if (def.validate(parsed.value)) {
      // Downgrade guard: a newer-than-code payload must never run through a
      // migrator written for older shapes, and must never be rewritten
      // stamped as the current version — either would destroy future data.
      if (parsed.version > def.version) {
        devWarn(def.key, `version skew (stored v${parsed.version}, code v${def.version}), loading as-is`);
        return parsed.value;
      }
      if (parsed.version < def.version && def.migrate) {
        try {
          const migrated = def.migrate(parsed.value, parsed.version);
          if (!def.validate(migrated)) throw new Error("migrate produced an invalid value");
          writeStore(def, migrated);
          return migrated;
        } catch {
          devWarn(def.key, "migration failed, falling back");
          return def.fallback();
        }
      }
      return parsed.value;
    }
    devWarn(def.key, `unrecognised shape (v${parsed.version}), falling back`);
    return def.fallback();
  }
  // Legacy unstamped payload: a migrator may still rescue it, otherwise
  // it must validate as the current shape to load.
  if (def.migrate) {
    try {
      const migrated = def.migrate(parsed, 0);
      if (def.validate(migrated)) {
        writeStore(def, migrated);
        return migrated;
      }
    } catch {
      /* fall through to fallback */
    }
  } else if (def.validate(parsed)) {
    return parsed;
  }
  devWarn(def.key, "legacy payload unreadable, falling back");
  return def.fallback();
}

export function writeStore<T>(def: StoreDef<T>, value: T): void {
  try {
    setWithFallback(def.key, JSON.stringify({ version: def.version, value }));
  } catch {
    /* quota or unavailable: state stays in memory */
  }
}

/** useState backed by a versioned store: loads once, persists on change. */
export function useVersionedState<T>(def: StoreDef<T>): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readStore(def));
  const set: Dispatch<SetStateAction<T>> = (action) => {
    setValue((prev) => {
      const next = typeof action === "function" ? (action as (p: T) => T)(prev) : action;
      if (next !== prev) writeStore(def, next);
      return next;
    });
  };
  return [value, set];
}
