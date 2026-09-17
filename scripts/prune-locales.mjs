// electron-builder afterPack hook (module path form, like beforePack):
// electron-builder imports this file and calls the default export with
// { appOutDir, outDir, arch, targets, packager, electronPlatformName }.
//
// Chromium ships ~70 locale packs (~42 MB) inside every Electron app.
// Babylon is English-only, so drop everything except en-US/en. Layouts:
//   mac:   <App>.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/*.lproj
//   linux: <appOutDir>/locales/*.pak
//   win:   <appOutDir>/locales/*.pak
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const KEEP = new Set(["en-US", "en"]);

function sizeOf(p) {
  try {
    let total = 0;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      total += e.isDirectory() ? sizeOf(full) : statSync(full).size;
    }
    return total;
  } catch {
    return 0;
  }
}

function pruneDir(dir, ext) {
  if (!existsSync(dir)) return 0;
  let freed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(ext)) continue;
    const base = name.slice(0, -ext.length);
    if (KEEP.has(base)) continue;
    const full = join(dir, name);
    freed += sizeOf(full);
    rmSync(full, { recursive: true, force: true });
    console.log(`[prune-locales] removed ${full}`);
  }
  return freed;
}

export default async function pruneLocales(context) {
  const { appOutDir = "", electronPlatformName = "" } = context ?? {};
  let dir = "";
  let ext = "";
  if (electronPlatformName === "darwin") {
    dir = join(
      appOutDir,
      "Babylon.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Resources"
    );
    // Product name may differ (e.g. __test__), so fall back to globbing.
    if (!existsSync(dir)) {
      try {
        const apps = readdirSync(appOutDir).filter((n) => n.endsWith(".app"));
        const found = apps
          .map((a) =>
            join(appOutDir, a, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources")
          )
          .find((d) => existsSync(d));
        if (found) dir = found;
      } catch { /* keep original dir; pruneDir no-ops */ }
    }
    ext = ".lproj";
  } else if (electronPlatformName === "linux" || electronPlatformName === "win32") {
    dir = join(appOutDir, "locales");
    ext = ".pak";
  } else {
    console.warn(`[prune-locales] unknown platform '${electronPlatformName}'; skipping`);
    return;
  }
  const freed = pruneDir(dir, ext);
  console.log(`[prune-locales] freed ${(freed / 1048576).toFixed(1)} MB in ${dir || "<missing dir>"}`);
}
