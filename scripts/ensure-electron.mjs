// Verifies the Electron binary in node_modules and repairs it if needed.
//
// Two failure modes on this project have been observed:
//  1. The package manager blocks electron's postinstall (pnpm 10 default) → dist/ never created.
//  2. electron's own zip extraction produces an incomplete Electron.app (missing Frameworks).
// In both cases this script downloads the official archive and unpacks it with `ditto`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

let electronDir;
try {
  electronDir = path.dirname(require.resolve("electron/package.json"));
} catch {
  console.log("[ensure-electron] electron package not installed; skipping");
  process.exit(0);
}

if (process.platform !== "darwin") {
  console.log("[ensure-electron] auto-repair is macOS-only; if the binary is broken, run `pnpm rebuild electron`");
  process.exit(0);
}

const version = JSON.parse(readFileSync(path.join(electronDir, "package.json"), "utf8")).version;
const distDir = path.join(electronDir, "dist");
const appDir = path.join(distDir, "Electron.app");
const pathTxt = path.join(electronDir, "path.txt");

function complete() {
  return (
    existsSync(path.join(appDir, "Contents", "MacOS", "Electron")) &&
    existsSync(path.join(appDir, "Contents", "Frameworks")) &&
    existsSync(pathTxt)
  );
}

if (complete()) process.exit(0);

console.log(`[ensure-electron] Electron v${version} binary missing/incomplete — repairing…`);

const zipName = `electron-v${version}-darwin-${os.arch() === "arm64" ? "arm64" : "x64"}.zip`;
const zipPath = path.join(os.tmpdir(), zipName);
if (!existsSync(zipPath)) {
  const url = `https://github.com/electron/electron/releases/download/v${version}/${zipName}`;
  console.log(`[ensure-electron] downloading ${url}`);
  const dl = spawnSync("curl", ["-sL", "--fail", "-o", zipPath, url], { stdio: "inherit" });
  if (dl.status !== 0) {
    console.error("[ensure-electron] download failed");
    process.exit(1);
  }
}

// Move any broken dist aside (rename, not recursive delete).
if (existsSync(distDir)) {
  renameSync(distDir, path.join(electronDir, `dist.broken-${Date.now()}`));
}
mkdirSync(distDir, { recursive: true });

const un = spawnSync("ditto", ["-x", "-k", zipPath, distDir], { stdio: "inherit" });
if (un.status !== 0) {
  console.error("[ensure-electron] extraction failed");
  process.exit(1);
}
writeFileSync(pathTxt, "Electron.app/Contents/MacOS/Electron");

if (!complete()) {
  console.error("[ensure-electron] still incomplete after repair");
  process.exit(1);
}
console.log("[ensure-electron] Electron binary repaired ✓");
