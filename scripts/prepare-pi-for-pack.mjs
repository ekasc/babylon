// Runs as electron-builder's beforePack hook (module path form, not a shell
// command): electron-builder imports this file and calls the default export
// with { appOutDir, outDir, arch, targets, packager, electronPlatformName }.
//
// Babylon pins @earendil-works/pi-coding-agent as a dependency, but a developer
// can override it with an ambient Pi via PI_PACKAGE_DIR (scripts/link-pi.mjs).
// electron-builder would follow that symlink and embed the installer's absolute
// home path in the package, so the package is staged as a real, fully
// dereferenced copy that electron-builder reads instead of the link.
//
// The staging copy is throwaway. An earlier version dereferenced the link *in
// place*, which replaced node_modules/@earendil-works/pi-coding-agent with a
// copy whose dependency links no longer resolved: the next build failed with
// resolution errors and 13 test files could not import Pi until it was
// re-linked. Nothing here may mutate node_modules outside the staging dir.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, cpSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const link = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const stage = join(root, "node_modules", ".pi-pack", "pi-coding-agent");
const linkPi = join(root, "scripts", "link-pi.mjs");

export default async function preparePiForPack(_context) {
  // Missing entirely (never linked): establish the link the same way
  // scripts/link-pi.mjs does. If Pi is genuinely absent, fail with an
  // actionable message instead of letting electron-builder fail cryptically on
  // the from path or ship a broken package.
  if (!existsSync(link)) {
    console.log("[prepare-pi] pi-coding-agent not linked; running scripts/link-pi.mjs…");
    const linked = spawnSync(process.execPath, [linkPi], { stdio: "inherit" });
    if (linked.status !== 0) {
      throw new Error(
        "[prepare-pi] @earendil-works/pi-coding-agent is required to package Babylon.\n" +
          "  Install Pi (or set PI_PACKAGE_DIR to its package directory) and rerun the build.\n" +
          "  Or run: node scripts/link-pi.mjs"
      );
    }
  }

  // Resolve through the link and copy the package whole, dereferencing pnpm's
  // nested symlinks (chalk, @earendil-works/pi-tui, …) so the bundle is
  // self-contained. The link itself is left exactly as it was.
  const source = realpathSync(link);
  console.log(`[prepare-pi] staging ${source} -> ${stage}`);
  rmSync(stage, { recursive: true, force: true });
  cpSync(source, stage, { recursive: true, dereference: true });

  for (const required of ["package.json", "dist", "node_modules"]) {
    if (!existsSync(join(stage, required))) {
      throw new Error(`[prepare-pi] staged package is missing ${required}; refusing to pack a broken bundle`);
    }
  }
  console.log("[prepare-pi] done");
}
