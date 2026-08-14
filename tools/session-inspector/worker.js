// Session Inspector — worker: parse + index + window reads + search + benchmark.
// Runs the shared core.js; the UI thread stays at 60fps.
import { parseEntries, totals, payloadEstimate, benchmark, topHeaviest } from "./core.js";

let file = null; // File handle (browser)
let entries = []; // { offset, length, type, role, ts, bytes } per JSONL line
let offsets = null; // Float64Array mirror for transfer
let lengths = null; // Uint32Array mirror
let roles = null; // string[] mirror

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "open": {
        file = msg.file;
        const content = await file.text();
        const t0 = performance.now();
        entries = parseEntries(content);
        const parseMs = performance.now() - t0;
        const t = totals(content);
        const payload = payloadEstimate(content);
        offsets = new Float64Array(entries.length);
        lengths = new Uint32Array(entries.length);
        roles = new Array(entries.length);
        for (let i = 0; i < entries.length; i++) {
          offsets[i] = entries[i].offset;
          lengths[i] = entries[i].length;
          roles[i] = entries[i].role ?? entries[i].type;
        }
        self.postMessage(
          {
            type: "ready",
            meta: {
              name: file.name,
              size: content.length,
              entries: entries.length,
              messages: t.messages,
              totals: { text: t.text, thinking: t.thinking, image: t.image, toolResult: t.toolResult, other: t.other },
              parseMs: round1(parseMs),
              payload: { fullKB: round1(payload.full / 1024), clampedKB: round1(payload.clamped / 1024), clampedCount: payload.clampedCount },
            },
            offsets,
            lengths,
            roles,
          },
          [offsets.buffer, lengths.buffer]
        );
        break;
      }
      case "entry-content": {
        const e = entries[msg.index];
        if (!e) { self.postMessage({ type: "entry-content", index: msg.index, raw: null }); break; }
        const raw = await sliceLine(file, e.offset, e.length);
        self.postMessage({ type: "entry-content", index: msg.index, raw });
        break;
      }
      case "search": {
        const needle = msg.needle.toLowerCase();
        const hits = [];
        const content = await file.text();
        const lines = content.split("\n");
        let offset = 0;
        for (let i = 0; i < lines.length && hits.length < 200; i++) {
          const line = lines[i];
          if (line.toLowerCase().includes(needle)) {
            hits.push({ index: i, snippet: line.slice(0, 160) });
          }
          offset += line.length + 1;
        }
        self.postMessage({ type: "search", needle: msg.needle, hits });
        break;
      }
      case "benchmark": {
        const content = await file.text();
        const result = benchmark(content);
        result.heaviest = topHeaviest(entries, 10).map((e) => ({
          index: entries.indexOf(e),
          role: e.role,
          bytes: e.bytes,
          ts: e.ts,
        }));
        self.postMessage({ type: "benchmark", result });
        break;
      }
    }
  } catch (error) {
    self.postMessage({ type: "error", message: String(error?.message ?? error) });
  }
};

async function sliceLine(file, offset, length) {
  const buf = await file.slice(offset, offset + length).text();
  return buf.replace(/\n$/, "");
}

function round1(x) {
  return Math.round(x * 10) / 10;
}
