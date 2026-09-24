/**
 * Wire readers: narrowing helpers for unvalidated objects off SDK/IPC
 * boundaries (session file entries, agent events, tool payloads). Every
 * read degrades to a default instead of throwing on malformed payloads.
 */

/** Unvalidated object off the wire. */
export type Wire = Record<string, unknown>;

/** True for non-null, non-array objects. The single spelling for the
 *  plain-object guard previously copy-pasted across daemon and event code. */
export function isPlainObject(value: unknown): value is Wire {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Named string guard so call sites stop redeclaring the same predicate. */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Array whose every element satisfies the guard (skill: isArrayOf pattern).
 *  Rejects non-arrays and partially-valid arrays outright. */
export function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

/** Plain object whose every value satisfies the guard. The validated shape
 *  for registry maps (tasks, attention, hooks, contracts). */
export function isRecordOf<T>(value: unknown, guard: (entry: unknown) => entry is T): value is Record<string, T> {
  return isPlainObject(value) && Object.values(value).every(guard);
}

export function wireOf(value: unknown): Wire | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Wire;
}

export function wireStr(wire: Wire | undefined, key: string): string | undefined {
  const v = wire?.[key];
  return typeof v === "string" ? v : undefined;
}

export function wireNum(wire: Wire | undefined, key: string): number | undefined {
  const v = wire?.[key];
  return typeof v === "number" ? v : undefined;
}

export function wireArr(wire: Wire | undefined, key: string): unknown[] | undefined {
  const v = wire?.[key];
  return Array.isArray(v) ? v : undefined;
}

/** String array with non-strings dropped (steer queues, dialog options). */
export function wireStrArr(wire: Wire | undefined, key: string): string[] | undefined {
  const v = wireArr(wire, key);
  if (!v) return undefined;
  return isArrayOf(v, isString) ? v : v.filter(isString);
}
