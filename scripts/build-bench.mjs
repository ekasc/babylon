#!/usr/bin/env node
// Build a CJS bundle containing only the snapshot store so the benchmark
// can require it without dragging in the full Electron main.
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outdir = path.join(root, "dist-bench");
await mkdir(outdir, { recursive: true });

await esbuild.build({
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  entryPoints: [path.join(root, "electron/snapshot-store.ts")],
  outfile: path.join(outdir, "snapshot-store.cjs"),
  sourcemap: true,
  // SnapshotStore only depends on node: built-ins, never electron.
  external: [],
});
console.log("bench: built dist-bench/snapshot-store.cjs");
