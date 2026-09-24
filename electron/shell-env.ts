// GUI-launched macOS apps (Finder, Dock, Spotlight) inherit the minimal
// environment a WindowServer session starts with — typically
// PATH=/usr/bin:/bin:/usr/sbin:/sbin and nothing else. Everything Babylon
// spawns reads process.env: pi's bash tool (via the SDK's getShellEnv), git,
// language servers, terminals. So homebrew, fnm, asdf, JAVA_HOME, GOPATH and
// anything else a terminal would have are invisible in the packaged app.
//
// Sourcing the user's login shell once at startup puts the packaged app on the
// same footing as a terminal launch.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/** Sentinel that separates any shell banner from the environment dump. */
export const LOGIN_ENV_MARKER = "__BABYLON_LOGIN_ENV__";
const MARKER = LOGIN_ENV_MARKER;
const TIMEOUT_MS = 3_000;

/** Directories a macOS GUI app should still find when no shell can be read. */
const FALLBACK_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"];

/**
 * Variables the app owns. A login shell must never override them: NODE_OPTIONS
 * and ELECTRON_* would change how Electron's own Node children start up, and
 * the BABYLON_ and PIDECK_ prefixes are how the app (and its daemon) is
 * configured.
 */
const PROTECTED_KEYS = new Set(["PATH", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL"]);
const PROTECTED_PREFIXES = ["ELECTRON_", "BABYLON_", "PIDECK_"];

function isProtected(key: string): boolean {
  return PROTECTED_KEYS.has(key) || PROTECTED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function splitPath(value: string | undefined): string[] {
  return (value ?? "").split(":").filter(Boolean);
}

/** Login entries first, then inherited entries not already present. */
export function mergePath(loginPath: string, inherited: string | undefined): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...splitPath(loginPath), ...splitPath(inherited)]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(":");
}

/**
 * Parse `env -0` output that follows the marker. Interactive shells can print a
 * banner first, so only the text after the last marker counts. Values may
 * contain `=` and newlines, so entries are NUL-separated and split on the first
 * `=` only.
 */
export function parseShellEnv(stdout: string): Record<string, string> | undefined {
  const index = stdout.lastIndexOf(MARKER);
  if (index === -1) return undefined;
  const env: Record<string, string> = {};
  for (const entry of stdout.slice(index + MARKER.length).split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Read a shell's environment. `-i` picks up interactive rc files (zsh sets PATH
 * in .zshrc), `-l` picks up login files (bash uses .bash_profile).
 */
export function readLoginShellEnv(shell: string): Promise<Record<string, string> | undefined> {
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", `printf '%s' "${MARKER}"; env -0`], { timeout: TIMEOUT_MS }, (error, stdout) => {
      if (error || typeof stdout !== "string") {
        resolve(undefined);
        return;
      }
      resolve(parseShellEnv(stdout));
    });
  });
}

/**
 * Overlay a captured shell environment onto `target`. Protected keys keep their
 * existing value; PATH is merged with the shell's entries first so the packaged
 * app finds the same binaries a terminal does. Exported for testing.
 */
export function applyShellEnv(target: NodeJS.ProcessEnv, captured: Record<string, string>): void {
  const shellPath = captured.PATH;
  for (const [key, value] of Object.entries(captured)) {
    if (key === "PATH" || isProtected(key)) continue;
    target[key] = value;
  }
  target.PATH = mergePath(shellPath ?? "", target.PATH);
}

/**
 * Source the login shell's environment into process.env. Best-effort: when no
 * shell can be read, the inherited environment is kept with the common macOS
 * package directories prepended so the app still finds homebrew tools.
 */
export async function importLoginShellEnv(): Promise<void> {
  const candidates: string[] = [];
  for (const shell of [process.env.SHELL, "/bin/zsh", "/bin/bash"]) {
    if (shell && !candidates.includes(shell)) candidates.push(shell);
  }

  let captured: Record<string, string> | undefined;
  for (const shell of candidates) {
    captured = await readLoginShellEnv(shell);
    if (captured) break;
  }

  if (!captured) {
    const fallback = FALLBACK_DIRS.filter(existsSync).join(":");
    process.env.PATH = mergePath(fallback, process.env.PATH);
    return;
  }
  applyShellEnv(process.env, captured);
}
