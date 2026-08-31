#!/usr/bin/env node
// Snapcompact evaluation driver.
//
// Run with:
//   tsx scripts/snapcompact-eval.mjs
//
//   BABYLON_LIVE_MODEL_URL=https://api.openai.com/v1/chat/completions \
//   BABYLON_LIVE_MODEL_KEY=sk-... \
//   BABYLON_LIVE_MODEL=gpt-4o \
//   tsx scripts/snapcompact-eval.mjs
//
// Without the BABYLON_LIVE_* env vars, the live retrieval is skipped
// and the model-ready request is written to
// docs/perf/snapcompact-live-request.json for offline grading.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateAllCoverage, formatCoverageReport, emitLiveRequest, runLiveRetrieval } from "../electron/snapcompact/eval.ts";
import { EVAL_FIXTURES } from "../electron/snapcompact/eval-fixtures.ts";

const reports = evaluateAllCoverage();
console.log(formatCoverageReport(reports));

// Live retrieval scaffold.
const liveUrl = process.env.BABYLON_LIVE_MODEL_URL ?? "";
const liveKey = process.env.BABYLON_LIVE_MODEL_KEY ?? "";
const liveModel = process.env.BABYLON_LIVE_MODEL ?? "";
const outBase = join(process.cwd(), "docs", "perf");
await writeFile(join(outBase, "snapcompact-coverage.txt"), formatCoverageReport(reports) + "\n", "utf8");
console.log(`wrote ${join(outBase, "snapcompact-coverage.txt")}`);

// Always persist the model-ready request under docs/perf/ for offline
// grading, then optionally run it through a configured vision endpoint.
const persistedPath = join(outBase, "snapcompact-live-request.json");
let bundle = {};
try {
  const existing = JSON.parse(await readFile(persistedPath, "utf8"));
  if (existing && typeof existing === "object") bundle = existing;
} catch {
  bundle = {};
}
for (const fixture of EVAL_FIXTURES) {
  const req = emitLiveRequest(fixture);
  bundle[fixture.id] = req;
  await writeFile(persistedPath, JSON.stringify(bundle, null, 2), "utf8");
  const tmp = await mkdtemp(join(tmpdir(), "pideck-snapcompact-live-"));
  try {
    const result = await runLiveRetrieval(req, { url: liveUrl, apiKey: liveKey, model: liveModel, outPath: tmp });
    if (result.ran && result.answers) {
      console.log(`live: ${fixture.id} -> ${result.answers.filter((a) => a.exact).length}/${result.answers.length} exact`);
    } else {
      console.log(`live: ${fixture.id} -> request persisted to ${persistedPath} (${result.ran ? "live run failed: " + (result.error ?? "?") : "no creds; grading offline"})`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
