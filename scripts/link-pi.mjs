// Ensures @earendil-works/pi-coding-agent resolves from node_modules.
// Pi currently ships this package with workspace dependencies, so Babylon links
// the package from an existing Pi installation instead of downloading a copy.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(root, "node_modules", "@earendil-works");
const link = join(targetDir, "pi-coding-agent");
const packageSuffix = join("@earendil-works", "pi-coding-agent");

function commandOutput(command, args = []) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function packageRootFromPiExecutable() {
  const locator = process.platform === "win32" ? "where" : "which";
  const executable = commandOutput(locator, ["pi"]).split(/\r?\n/, 1)[0];
  if (!executable) return null;
  try {
    const resolved = realpathSync(executable);
    const packageRoot = dirname(dirname(resolved));
    return existsSync(join(packageRoot, "package.json")) ? packageRoot : null;
  } catch {
    return null;
  }
}

function vitePlusPackageRoots() {
  const base = join(process.env.HOME ?? "", ".vite-plus", "js_runtime", "node");
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(base, entry.name, "lib", "node_modules", packageSuffix));
  } catch {
    return [];
  }
}

const globalRoot = commandOutput("npm", ["root", "-g"]);
const candidates = [
  process.env.PI_PACKAGE_DIR,
  packageRootFromPiExecutable(),
  globalRoot ? join(globalRoot, packageSuffix) : null,
  ...vitePlusPackageRoots(),
];

const source = candidates.find((candidate) => candidate && existsSync(join(candidate, "package.json")));
if (!source) {
  console.error(
    "[link-pi] could not locate @earendil-works/pi-coding-agent; set PI_PACKAGE_DIR to its package directory"
  );
  process.exit(1);
}

try {
  if (existsSync(link) && realpathSync(link) === realpathSync(source)) process.exit(0);
} catch {
  // Replace stale or incomplete links below.
}

rmSync(link, { force: true, recursive: true });
mkdirSync(targetDir, { recursive: true });
symlinkSync(source, link, "dir");
console.log(`[link-pi] linked @earendil-works/pi-coding-agent -> ${source}`);
