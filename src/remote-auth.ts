// Remote authentication helpers for Phase 7 (Remote Control, Feature 15).
//
// Paired devices authenticate with a per-device token. Only the SHA-256 hash
// of the token is stored in the device registry, so a leaked snapshot does not
// leak usable credentials. Comparison uses timingSafeEqual so a remote peer
// cannot recover the hash byte by byte from timing.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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

/** Generate a pairing token from CSPRNG bytes: 128 bits of entropy. */
export function newPairingToken(): string {
  return randomBytes(16).toString("hex");
}
