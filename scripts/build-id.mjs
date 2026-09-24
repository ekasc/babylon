// Content-derived build identity for daemon skew detection. Scoped to the
// code the daemon bundle can contain: src (minus UI), electron, daemon, and
// the dependency manifests. Renderer-only edits (components, styles, tests)
// must NOT move the id, or every UI tweak would retire a healthy daemon on
// next startup. Daemon-affecting edits move it in both bundles, so a stale
// holder is retired even when the protocol version did not change.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_DIRS = ["src", "electron", "daemon"];
const SOURCE_FILES = ["package.json", "pnpm-lock.yaml"];
const EXCLUDE_DIRS = new Set(["components", "prototype"]);
// Renderer entries and styles never reach the daemon bundle.
const EXCLUDE_BASENAMES = new Set(["App.tsx", "main.tsx"]);
const SOURCE = /\.(ts|tsx|js|mjs|cjs|json)$/;
const EXCLUDE_FILES = [/\.test\.[jt]sx?$/, /\.css$/];

function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      collect(full, out);
    } else if (entry.isFile() && SOURCE.test(entry.name) && !EXCLUDE_BASENAMES.has(entry.name) && !EXCLUDE_FILES.some((re) => re.test(entry.name))) {
      out.push(full);
    }
  }
}

export function computeBuildId(root) {
  const files = [];
  for (const dir of SOURCE_DIRS) collect(join(root, dir), files);
  for (const file of SOURCE_FILES) {
    const full = join(root, file);
    if (existsSync(full)) files.push(full);
  }
  files.sort();
  const hash = createHash("sha1");
  for (const file of files) {
    hash.update(file.slice(root.length + 1));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex").slice(0, 16);
}
