// Dev orchestrator: watches electron/*.ts with esbuild and (re)starts Electron
// against the Vite dev server. Renderer HMR comes from Vite itself.
import esbuild from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { context: createContext } = esbuild;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const devUrl = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron", "@earendil-works/pi-coding-agent"],
  sourcemap: true,
  logLevel: "silent",
};

let electron = null;
let restarting = false;
let restartTimer = null;
let builtOnce = false;

function startElectron() {
  electron = spawn(path.join(root, "node_modules", ".bin", "electron"), ["."], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
  });
  electron.on("exit", (code, signal) => {
    if (restarting) return;
    // Under a smoke-test kill (SIGTERM → code null), treat as success.
    process.exit(signal && code === null ? 0 : (code ?? 0));
  });
}

function scheduleRestart() {
  if (!builtOnce || restarting) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log("\n[pideck] electron/ changed — restarting Electron…");
    restarting = true;
    const old = electron;
    old?.once("exit", () => {
      restarting = false;
      startElectron();
    });
    old?.kill("SIGTERM");
  }, 500);
}

const restartPlugin = {
  name: "pideck-restart",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      if (!builtOnce) {
        builtOnce = true;
        void (async () => {
          // Wait for Vite before opening the window.
          const t0 = Date.now();
          for (;;) {
            try {
              const r = await fetch(devUrl);
              if (r.ok) break;
            } catch {
              /* not up yet */
            }
            if (Date.now() - t0 > 30_000) {
              console.error("[pideck] Vite dev server did not come up at", devUrl);
              process.exit(1);
            }
            await new Promise((r) => setTimeout(r, 300));
          }
          startElectron();
        })();
      } else {
        scheduleRestart();
      }
    });
  },
};

const mainCtx = await createContext({
  ...shared,
  entryPoints: [path.join(root, "electron/main.ts")],
  outfile: path.join(root, "dist-electron/main.mjs"),
  plugins: [restartPlugin],
});
const preloadCtx = await createContext({
  ...shared,
  format: "cjs",
  entryPoints: [path.join(root, "electron/preload.ts")],
  outfile: path.join(root, "dist-electron/preload.cjs"),
  plugins: [restartPlugin],
});

await mainCtx.watch();
await preloadCtx.watch();
await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild()]);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    electron?.kill(sig);
    process.exit(0);
  });
}
