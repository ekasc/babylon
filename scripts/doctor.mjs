// babylon doctor trampoline: bundles the TypeScript CLI on the fly and runs
// it, so `pnpm doctor` never goes stale and needs no build step.
// Usage: node scripts/doctor.mjs [--data-dir <userData>] [--state-dir <dir>] [--prod]
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildId } from "./build-id.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const built = await esbuild.build({
  entryPoints: [path.join(root, "electron", "doctor-cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["@earendil-works/pi-coding-agent"],
  logLevel: "silent",
  write: false,
});

process.env.BABYLON_SOURCE_BUILD_ID = computeBuildId(root);
await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
