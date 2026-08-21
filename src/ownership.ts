// Stable ownership (Cross-cutting infrastructure).
//
// Every long-lived resource should name its owner explicitly instead of
// inheriting identity from whichever UI panel happens to be open. These
// helpers give subsystem boundaries one vocabulary for that rule: build a
// stamp, require the ids a boundary cannot proceed without, and describe a
// stamp for logs and diagnostics.

import type { OwnershipKey, OwnershipRef } from "./events";
import { OWNERSHIP_KEYS } from "./events";

export type { OwnershipKey, OwnershipRef };

/** Build a stamp from raw parts; blank/undefined values are dropped so a half-filled form cannot masquerade as ownership. */
export function stampOwnership(parts: OwnershipRef): OwnershipRef {
  const stamp: OwnershipRef = {};
  for (const key of OWNERSHIP_KEYS) {
    const value = parts[key];
    if (typeof value === "string" && value.trim().length > 0) stamp[key] = value;
  }
  return stamp;
}

/**
 * Enforce that a stamp carries the ids a boundary requires. Throws rather
 * than guessing: an unowned resource is a bug, not a default.
 */
export function requireOwners(stamp: OwnershipRef, keys: OwnershipKey[]): void {
  const missing = keys.filter((key) => typeof stamp[key] !== "string");
  if (missing.length > 0) {
    throw new Error(`missing required ownership: ${missing.join(", ")}`);
  }
}

/** True when both stamps agree on every key both mention. */
export function sameOwner(a: OwnershipRef, b: OwnershipRef): boolean {
  for (const key of OWNERSHIP_KEYS) {
    const av = a[key];
    const bv = b[key];
    if (av !== undefined && bv !== undefined && av !== bv) return false;
  }
  return true;
}

/** Short human-readable form for logs: "task=t1 session=s7". */
export function describeOwner(stamp: OwnershipRef): string {
  return (
    OWNERSHIP_KEYS.filter((key) => stamp[key] !== undefined)
      .map((key) => `${key.replace(/Id$/, "")}=${stamp[key]}`)
      .join(" ") || "unowned"
  );
}
