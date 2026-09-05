import * as Effect from "effect/Effect";
import { getJsonWithFallback, getNumberWithFallback, getWithFallback } from "./storage";

export const getWithFallbackEffect = (key: string): Effect.Effect<string | null> =>
  Effect.sync(() => {
    if (typeof localStorage === "undefined") return null;
    return getWithFallback(key);
  });

export const getNumberWithFallbackEffect = (key: string, fallback: number): Effect.Effect<number> =>
  Effect.sync(() => {
    if (typeof localStorage === "undefined") return fallback;
    return getNumberWithFallback(key, fallback);
  });

export const getJsonWithFallbackEffect = <T>(key: string, fallback: T): Effect.Effect<T> =>
  Effect.sync(() => {
    if (typeof localStorage === "undefined") return fallback;
    return getJsonWithFallback(key, fallback);
  });

export const setItemEffect = (key: string, value: string): Effect.Effect<void> =>
  Effect.sync(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(`babylon:${key}`, value);
  });

export const removeItemEffect = (key: string): Effect.Effect<void> =>
  Effect.sync(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(`babylon:${key}`);
  });
