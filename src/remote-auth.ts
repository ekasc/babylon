// Remote authentication helpers for Phase 7 (Remote Control, Feature 15).
//
// Paired devices authenticate with a per-device token. Only the SHA-256 hash
// of the token is stored in the device registry, so a leaked snapshot does not
// leak usable credentials. Comparison uses timingSafeEqual so a remote peer
// cannot recover the hash byte by byte from timing.

import { createHash, timingSafeEqual } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyToken(token: string, expectedHash: string): boolean {
  if (typeof token !== "string" || typeof expectedHash !== "string") return false;
  const actual = Buffer.from(hashToken(token), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Generate a pairing token with enough entropy to resist offline guessing. */
export function newPairingToken(): string {
  return createHash("sha256")
    .update(`${Date.now()}-${Math.random()}-${process.pid}`)
    .digest("hex")
    .slice(0, 32);
}
