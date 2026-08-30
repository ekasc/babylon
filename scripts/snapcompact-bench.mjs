#!/usr/bin/env node
// Snapcompact build-performance benchmark.
//
// Measures the snapcompact pipeline (serialize -> extract symbols ->
// render frames) at message-window sizes of 10k, 50k, 100k, 200k, 500k,
// 1M characters per the spec. Reports serialization time, render time,
// frame count, output bytes, and per-stage timing.
//
// Run with:
//   node scripts/snapcompact-bench.mjs
//   node scripts/snapcompact-bench.mjs --scales 10000,50000,100000 --iterations 3
//
// Pure Node, no LLM, no network. The synthetic messages are deterministic
// (seeded by index) so re-runs produce the same character count.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

function parseArgs(argv) {
  const opts = { scales: [10000, 50000, 100000, 200000, 500000, 1000000], iterations: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scales") opts.scales = argv[++i].split(",").map(Number);
    else if (a === "--iterations") opts.iterations = Number(argv[++i]);
  }
  return opts;
}

function makeUserMessage(targetChars) {
  const pad = "the quick brown fox jumps over the lazy dog. ";
  let out = "";
  while (out.length < targetChars) out += pad;
  return out.slice(0, targetChars);
}

function makeMessages(approxTotalChars) {
  const messages = [];
  const userChunk = 400;
  const assistantChunk = 600;
  let total = 0;
  let i = 0;
  while (total < approxTotalChars) {
    messages.push({ role: "user", content: makeUserMessage(userChunk), entryId: `u${i}`, timestamp: i * 1000 });
    total += userChunk;
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: makeUserMessage(assistantChunk) }],
      entryId: `a${i}`,
      timestamp: i * 1000 + 500,
      toolCalls: i % 5 === 0 ? [{ id: `tc${i}`, name: "read", arguments: JSON.stringify({ path: `/repo/src/file${i}.ts` }) }] : [],
    });
    total += assistantChunk;
    i++;
  }
  return messages;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mod = await import("../electron/snapcompact/serializer.ts");
  const sym = await import("../electron/snapcompact/symbol-dictionary.ts");
  const rendererMod = await import("../electron/snapcompact/renderer.ts");
  const profileMod = await import("../electron/snapcompact/model-profiles.ts");
  const serialize = mod.serializeTranscript;
  const extract = sym.extractHighValueTokens;
  const render = rendererMod.renderFrames;
  const profile = profileMod.profileToFrameProfile(profileMod.profileForModel({ id: "generic-vision" }));

  const results = [];
  for (const scale of opts.scales) {
    const messages = makeMessages(scale);
    const samples = [];
    for (let i = 0; i < opts.iterations; i++) {
      const t0 = performance.now();
      const serialized = serialize({ messages });
      const t1 = performance.now();
      const rawSymbols = extract(serialized.sourceText);
      const t2 = performance.now();
      const rendered = render({ sourceText: serialized.sourceText, rawSymbols, profile });
      const t3 = performance.now();
      const frameBytes = rendered.frames.reduce((n, f) => n + f.png.length, 0);
      samples.push({
        serializeMs: t1 - t0,
        extractMs: t2 - t1,
        renderMs: t3 - t2,
        totalMs: t3 - t0,
        sourceChars: serialized.sourceText.length,
        frameCount: rendered.frames.length,
        frameBytes,
        symbolCount: rendered.symbols.length,
        truncated: rendered.truncated,
      });
    }
    const median = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const m = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
    };
    results.push({
      scale,
      sourceCharsMedian: median(samples.map((s) => s.sourceChars)),
      totalMsMedian: median(samples.map((s) => s.totalMs)),
      serializeMsMedian: median(samples.map((s) => s.serializeMs)),
      extractMsMedian: median(samples.map((s) => s.extractMs)),
      renderMsMedian: median(samples.map((s) => s.renderMs)),
      frameCountMedian: median(samples.map((s) => s.frameCount)),
      frameBytesMedian: median(samples.map((s) => s.frameBytes)),
      symbolCountMedian: median(samples.map((s) => s.symbolCount)),
      truncated: samples.every((s) => s.truncated),
    });
  }

  console.log("scale | sourceChars | totalMs | serializeMs | extractMs | renderMs | frames | frameBytes | symbols | trunc");
  for (const r of results) {
    console.log(
      [
        String(r.scale).padStart(8),
        String(r.sourceCharsMedian).padStart(11),
        r.totalMsMedian.toFixed(1).padStart(8),
        r.serializeMsMedian.toFixed(1).padStart(12),
        r.extractMsMedian.toFixed(1).padStart(10),
        r.renderMsMedian.toFixed(1).padStart(9),
        String(r.frameCountMedian).padStart(6),
        String(r.frameBytesMedian).padStart(10),
        String(r.symbolCountMedian).padStart(8),
        r.truncated ? "Y" : "N",
      ].join(" | ")
    );
  }
  const report = {
    benchmark: "snapcompact-build",
    ts: new Date().toISOString(),
    iterations: opts.iterations,
    results,
  };
  const dir = await mkdtemp(join(tmpdir(), "pideck-snapcompact-bench-"));
  try {
    await writeFile(join(dir, "snapcompact-bench.json"), JSON.stringify(report, null, 2));
    console.log(`\nwrote ${join(dir, "snapcompact-bench.json")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
