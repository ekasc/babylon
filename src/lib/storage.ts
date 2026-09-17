// Cached localStorage access. Reads are synchronous and some happen on render
// paths; caching avoids repeated blocking storage hits. Writes must go through
// `setWithFallback` so the cache stays coherent, and cross-document changes
// invalidate via the `storage` event.
const cache = new Map<string, string | null>();

if (typeof window !== "undefined") {
  window.addEventListener("storage", () => cache.clear());
}

function cachedGet(fullKey: string): string | null {
  if (cache.has(fullKey)) return cache.get(fullKey) ?? null;
  const value = localStorage.getItem(fullKey);
  cache.set(fullKey, value);
  return value;
}

export function getWithFallback(key: string): string | null {
  return cachedGet(`babylon:${key}`) ?? cachedGet(`pideck:${key}`);
}

export function setWithFallback(key: string, value: string): void {
  const fullKey = `babylon:${key}`;
  localStorage.setItem(fullKey, value);
  cache.set(fullKey, value);
}

export function removeWithFallback(key: string): void {
  localStorage.removeItem(`babylon:${key}`);
  cache.delete(`babylon:${key}`);
}

/** Drop all cached reads (cross-document edits, tests). */
export function clearStorageCache(): void {
  cache.clear();
}

export function getNumberWithFallback(key: string, fallback: number): number {
  const raw = getWithFallback(key);
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function getJsonWithFallback<T>(key: string, fallback: T): T {
  const raw = getWithFallback(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
