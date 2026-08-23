// Dev orchestrator: watches electron/*.ts with esbuild and starts Electron once
// against the Vite dev server. Renderer updates are handled by Vite HMR.
// Main/preload rebuilds are written to disk but never reload or restart the app.
import esbuild from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { context: createContext } = esbuild;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const devUrl = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";

const requireBanner = {
  js: `import { createRequire as topLevelCreateRequire } from "module"; const require = topLevelCreateRequire(import.meta.url);`,
};

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  // Pi loads provider auth and API implementations with relative dynamic
  // imports. Keep the package intact so those imports resolve inside it.
  external: ["electron", "@earendil-works/pi-coding-agent"],
  sourcemap: true,
  logLevel: "silent",
};

let electron = null;
let starting = false;
const initialBuilds = new Set();

function startElectron() {
  const debugArgs = process.env.PIDECK_CDP ? ["--remote-debugging-port=9222"] : [];
  electron = spawn(path.join(root, "node_modules", ".bin", "electron"), [".", ...debugArgs], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
  });
  electron.on("exit", (code, signal) => {
    process.exit(signal && code === null ? 0 : (code ?? 0));
  });
}

async function startWhenReady() {
  if (starting || electron || initialBuilds.size < 2) return;
  starting = true;
  const startedAt = Date.now();
  for (;;) {
    try {
      const response = await fetch(devUrl);
      if (response.ok) break;
    } catch {
      // Vite is still starting.
    }
    if (Date.now() - startedAt > 30_000) {
      console.error("[pideck] Vite dev server did not come up at", devUrl);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  startElectron();
}

const buildPlugin = (label) => ({
  name: `pideck-${label}-build`,
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      if (!initialBuilds.has(label)) {
        initialBuilds.add(label);
        void startWhenReady();
        return;
      }
      if (electron) console.log(`[pideck] ${label} rebuilt; restart pnpm dev to apply.`);
    });
  },
});

const mainCtx = await createContext({
  ...shared,
  banner: requireBanner,
  entryPoints: [path.join(root, "electron/main.ts")],
  outfile: path.join(root, "dist-electron/main.mjs"),
  plugins: [buildPlugin("main")],
});
const preloadCtx = await createContext({
  ...shared,
  format: "cjs",
  entryPoints: [path.join(root, "electron/preload.ts")],
  outfile: path.join(root, "dist-electron/preload.cjs"),
  plugins: [buildPlugin("preload")],
});

await Promise.all([mainCtx.watch(), preloadCtx.watch()]);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    electron?.kill(signal);
    process.exit(0);
  });
}
