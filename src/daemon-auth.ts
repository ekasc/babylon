// Owner-provisioned credentials for the daemon's optional TCP listener.
//
// The Unix socket relies on owner-only filesystem permissions (0600). TCP
// loopback has no equivalent, so TCP mode requires every connection to
// present a bearer token first (`daemon.auth`). The token lives in a
// 0600 file beside the daemon state; only the hash is ever held in memory
// on the server side.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function daemonTokenPath(dir: string): string {
  return join(dir, "daemon-token");
}

function looksLikeToken(value: string): boolean {
  return /^[0-9a-f]{32,256}$/i.test(value.trim());
}

/**
 * Read the owner token, creating one (0600) when absent. An explicit
 * `BABYLON_DAEMON_TOKEN` env value wins and is never written to disk.
 */
export function loadOrCreateDaemonToken(dir: string): string {
  const env = process.env.BABYLON_DAEMON_TOKEN;
  if (env && looksLikeToken(env)) return env.trim();
  const path = daemonTokenPath(dir);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (looksLikeToken(existing)) return existing;
  } catch {
    // Missing or unreadable: fall through to provisioning.
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort: the mode flag above already applied on creation.
  }
  return token;
}
