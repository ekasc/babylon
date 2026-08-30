// Runs as electron-builder's beforePack hook (module path form, not a shell
// command): electron-builder imports this file and calls the default export
// with { appOutDir, outDir, arch, targets, packager, electronPlatformName }.
//
// Babylon links @earendil-works/pi-coding-agent from an existing Pi
// installation (scripts/link-pi.mjs) instead of declaring it as a dependency.
// electron-builder would follow that symlink and embed the installer's
// absolute home path in the package, so before packing we dereference the link
// into a real copy inside node_modules. Packaging then reads from a relative
// path that is valid on any machine.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, rmSync, cpSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const link = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const linkPi = join(root, "scripts", "link-pi.mjs");

export default async function preparePiForPack(_context) {
  // Missing entirely (never linked): try to establish the link the same way
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

  try {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) {
      console.log("[prepare-pi] pi-coding-agent is a real directory; nothing to dereference");
      return;
    }
    const target = realpathSync(link);
    console.log(`[prepare-pi] dereferencing symlink ${link} -> ${target}`);
    rmSync(link, { recursive: true, force: true });
    cpSync(target, link, { recursive: true, dereference: true });
    console.log("[prepare-pi] done");
  } catch (e) {
    console.warn("[prepare-pi] failed", e);
  }
}