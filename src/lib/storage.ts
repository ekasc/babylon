export function getWithFallback(key: string): string | null {
  return localStorage.getItem(`babylon:${key}`) ?? localStorage.getItem(`pideck:${key}`);
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
