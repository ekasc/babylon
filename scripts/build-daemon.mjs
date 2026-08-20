// One-shot production build of the Babylon daemon bundle.
// Mirrors scripts/build-electron.mjs's esbuild options: ESM output with a
// createRequire-backed `require` banner for transitive CJS dependencies.
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await esbuild.build({
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: `import { createRequire as topLevelCreateRequire } from "module"; const require = topLevelCreateRequire(import.meta.url);`,
  },
  entryPoints: [path.join(root, "daemon/main.ts")],
  outfile: path.join(root, "dist-daemon/main.mjs"),
  sourcemap: true,
});
