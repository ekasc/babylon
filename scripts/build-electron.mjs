// One-shot production build of the Electron main + preload bundles.
// Mirrors scripts/dev-electron.mjs's esbuild options. The main bundle is ESM,
// so it needs a createRequire-backed `require` banner (a transitive CJS dep
// does dynamic require("child_process")); the preload is CJS and needs none.
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const requireBanner = {
  js: `import { createRequire as topLevelCreateRequire } from "module"; const require = topLevelCreateRequire(import.meta.url);`,
};

const shared = {
  bundle: true,
  platform: "node",
  // Pi loads provider auth and API implementations with relative dynamic
  // imports. Keep the package intact so those imports resolve inside it.
  external: ["electron", "@earendil-works/pi-coding-agent"],
  sourcemap: true,
};

await esbuild.build({
  ...shared,
  banner: requireBanner,
  format: "esm",
  entryPoints: [path.join(root, "electron/main.ts")],
  outfile: path.join(root, "dist-electron/main.mjs"),
});

await esbuild.build({
  ...shared,
  format: "cjs",
  entryPoints: [path.join(root, "electron/preload.ts")],
  outfile: path.join(root, "dist-electron/preload.cjs"),
});
