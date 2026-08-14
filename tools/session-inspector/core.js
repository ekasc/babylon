// Session Inspector — shared analysis core.
// Pure functions over session file content, used by both the browser worker
// and node tooling (snapshot capture). No DOM, no worker APIs.

/** Hard cap applied to non-diff tool output text when estimating the clamped
 *  wire payload (mirrors W1: clamp at the renderer boundary). */
export const OUTPUT_CLAMP = 16 * 1024;

export function parseEntries(content) {
  const entries = [];
  const lines = content.split("\n");
  let offset = 0;
  for (const line of lines) {
    const length = line.length + 1; // include the newline
    if (line.trim()) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === "object") {
          const m = entry.message ?? {};
          entries.push({
            id: entry.id ?? m.id ?? null,
            parentId: entry.parentId ?? null,
            type: entry.type ?? "?",
            role: m.role ?? null,
            ts: Date.parse(entry.timestamp ?? "") || null,
            offset,
            length,
            bytes: length,
            truncated: false,
          });
        }
      } catch {
        /* malformed line: record as opaque */
        entries.push({ id: null, parentId: null, type: "?raw", role: null, ts: null, offset, length, bytes: length, truncated: false });
      }
    }
    offset += length;
  }
  return entries;
}

/** Block-level byte profile of one parsed line's message content. Tool-result
 *  text is attributed to toolResult (not text); patch/diff details are counted
 *  separately as diff (they ship in full, per the diffs-with-shiki policy). */
function contentProfile(message) {
  const p = { text: 0, thinking: 0, image: 0, toolResult: 0, diff: 0, other: 0 };
  const content = message?.content;
  const role = message?.role;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") {
        const n = b.text?.length ?? 0;
        if (role === "toolResult") p.toolResult += n;
        else p.text += n;
      } else if (b.type === "thinking") p.thinking += (b.thinking?.length ?? 0);
      else if (b.type === "image") p.image += (b.data ?? b.source?.data ?? "").length;
      else if (b.type === "toolCall") p.other += JSON.stringify(b.arguments ?? "").length;
      else p.other += 1;
    }
  } else if (typeof content === "string") {
    const n = content.length;
    if (role === "toolResult") p.toolResult += n;
    else p.text += n;
  }
  if (typeof message?.output === "string") p.toolResult += message.output.length;
  const d = message?.details;
  if (d && typeof d === "object") {
    for (const k of ["patch", "diff"]) {
      if (typeof d[k] === "string") p.diff += d[k].length;
    }
  }
  return p;
}

const TYPE_KEYS = ["text", "thinking", "image", "toolResult", "diff", "other"];

/** Per-type byte totals across the whole file (excludes the JSON envelope). */
export function totals(content) {
  const totals = { text: 0, thinking: 0, image: 0, toolResult: 0, diff: 0, other: 0, messages: 0, rawBytes: 0 };
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "message") continue;
      totals.messages++;
      const p = contentProfile(entry.message);
      for (const k of TYPE_KEYS) totals[k] += p[k];
      totals.rawBytes += line.length;
    } catch {
      /* skip */
    }
  }
  return totals;
}

/** Estimate of the wire payload the renderer would receive: full vs after W1. */
export function payloadEstimate(content) {
  let full = 0;
  let clamped = 0;
  let clampedCount = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "message") continue;
      const m = entry.message ?? {};
      const p = contentProfile(m);
      full += p.text + p.thinking + p.image + p.toolResult + p.diff + p.other;
      // Diffs ship in full (diffs are shown with shiki); tool output clamps.
      const toolClamped = Math.min(p.toolResult, OUTPUT_CLAMP);
      if (p.toolResult > OUTPUT_CLAMP) clampedCount++;
      clamped += p.text + p.thinking + p.image + toolClamped + p.diff + p.other;
    } catch {
      /* skip */
    }
  }
  return { full, clamped, clampedCount };
}

/** Full pipeline benchmark for one file's content. */
export function benchmark(content) {
  const t0 = performance.now();
  const entries = parseEntries(content);
  const parseMs = performance.now() - t0;
  const t1 = performance.now();
  const t = totals(content);
  const totalsMs = performance.now() - t1;
  const t2 = performance.now();
  const payload = payloadEstimate(content);
  const payloadMs = performance.now() - t2;
  return {
    bytes: content.length,
    entries: entries.length,
    messages: t.messages,
    parseMs: round1(parseMs),
    totalsMs: round1(totalsMs),
    payloadMs: round1(payloadMs),
    payload: {
      fullKB: round1(payload.full / 1024),
      clampedKB: round1(payload.clamped / 1024),
      clampedCount: payload.clampedCount,
    },
  };
}

export function topHeaviest(entries, n = 10) {
  return entries
    .filter((e) => e.type === "message")
    .map((e) => e)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, n);
}

export function round1(x) {
  return Math.round(x * 10) / 10;
}
