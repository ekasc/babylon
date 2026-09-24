// Ensures @earendil-works/pi-coding-agent resolves from node_modules.
//
// Babylon declares the SDK as a pinned dependency (see package.json), so a
// fresh `pnpm install` already yields a known-good copy. This script only
// links an ambient Pi installation when explicitly asked via PI_PACKAGE_DIR
// (e.g. to develop against a local Pi checkout). Blindly floating on the
// ambient global Pi broke the app hard in the past: a newer global copy
// (0.85.x) loads dist/experimental/server.js from its own entry chain, which
// imports the undeclared sibling @earendil-works/pi-server and crashes the
// main process with ERR_MODULE_NOT_FOUND when that sibling is absent.
// Whichever copy ends up linked is smoke-tested below so a broken SDK fails
// here with a remediation instead of at app startup.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(root, "node_modules", "@earendil-works");
const link = join(targetDir, "pi-coding-agent");

function readVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

/** Import the SDK entry in a child process. Catches broken installs (missing
 *  siblings, undeclared deps like @earendil-works/pi-server) before they can
 *  crash Electron's main process with an uncaught exception. */
function smokeTestSdk(dir) {
  void dir;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const pkg = await import("@earendil-works/pi-coding-agent"); if (!pkg || typeof pkg !== "object") throw new Error("empty SDK namespace");`,
    ],
    { encoding: "utf8", timeout: 120000, cwd: root }
  );
  return child.status === 0 ? null : (child.stderr || child.stdout || `exit ${child.status}`);
}

const override = process.env.PI_PACKAGE_DIR;
if (!override) {
  if (existsSync(join(link, "package.json"))) {
    const failure = smokeTestSdk(link);
    if (failure) {
      console.error(
        `[link-pi] the installed @earendil-works/pi-coding-agent (${readVersion(link)}) failed to load:\n` +
          `  ${String(failure).split("\n").slice(0, 5).join("\n  ")}\n` +
          "  Reinstall it (pnpm install --force) or point PI_PACKAGE_DIR at a working Pi copy."
      );
      process.exit(1);
    }
    console.log(`[link-pi] using declared dependency @earendil-works/pi-coding-agent@${readVersion(link)}; set PI_PACKAGE_DIR to override with an ambient Pi`);
    process.exit(0);
  }
  console.error(
    "[link-pi] @earendil-works/pi-coding-agent is missing; run pnpm install, or set PI_PACKAGE_DIR to its package directory"
  );
  process.exit(1);
}

if (!existsSync(join(override, "package.json"))) {
  console.error(`[link-pi] PI_PACKAGE_DIR=${override} has no package.json`);
  process.exit(1);
}
rmSync(link, { force: true, recursive: true });
mkdirSync(targetDir, { recursive: true });
symlinkSync(override, link, "dir");
const failure = smokeTestSdk(link);
if (failure) {
  console.error(
    `[link-pi] PI_PACKAGE_DIR copy (${readVersion(override)}) failed to load:\n` +
      `  ${String(failure).split("\n").slice(0, 5).join("\n  ")}\n` +
      "  This is the crash you would get at app startup (e.g. pi 0.85.x without its @earendil-works/pi-server sibling).\n" +
      "  Reinstall Pi properly, or unset PI_PACKAGE_DIR to use the pinned dependency."
  );
  process.exit(1);
}
console.log(`[link-pi] linked @earendil-works/pi-coding-agent -> ${override}`);
