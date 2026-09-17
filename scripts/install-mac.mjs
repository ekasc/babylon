// Installs the freshly packaged macOS bundle into /Applications.
// Run via: npm run install:mac
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const APP_NAME = "Babylon";
const srcDir = process.arch === "arm64" ? "mac-arm64" : "mac";
const src = path.join(root, "release", srcDir, `${APP_NAME}.app`);
const dest = `/Applications/${APP_NAME}.app`;

if (!fs.existsSync(src)) {
  console.error(`Missing bundle: ${src}\nRun npm run dist:mac first.`);
  process.exit(1);
}

// Quit a running copy so busy files don't block the replace.
try {
  await execFileAsync("osascript", ["-e", `tell application "${APP_NAME}" to quit`]);
  await new Promise((r) => setTimeout(r, 2000));
} catch {
  // Not running; nothing to quit.
}

// Remove first: copying over an old bundle leaves stale files behind and
// breaks the code signature.
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });

await execFileAsync("codesign", ["--verify", "--deep", "--strict", dest]);
console.log(`Installed ${dest}`);
