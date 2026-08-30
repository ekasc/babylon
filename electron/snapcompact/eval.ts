// Snapcompact evaluation harness (offline coverage + live retrieval).
//
// Two outputs, separated by purpose:
//
//   1. Offline coverage evaluation (`evaluateCoverage`).
//      Deterministic. No LLM. Measures what the archive *contains*
//      and what the request will look like, NOT whether a vision
//      model can retrieve facts from a bitmap. The previous version
//      of this harness string-searched the pre-rasterization source
//      text and called that "retrieval accuracy"; that was
//      measurement of the wrong thing and is gone.
//
//      Coverage checks:
//        - serializer coverage fields are truthful
//          (firstKeptEntryId / lastKeptEntryId / keptCount /
//          omittedTrailing)
//        - frame plan covers every line exactly once, or records
//          omission via the omission-marker frame
//        - exact-token dictionary contains the expected anchors
//        - serialized request byte/token estimates
//        - build performance
//
//      Three reference projections are compared:
//        - raw text baseline
//        - prefix-control (the first 1500 chars of the serialized
//          source) — labelled as a deterministic prefix control,
//          NOT as "existing summary compaction" (that would be Pi's
//          own LLM summary path which the harness does not call)
//        - snapcompact archive (frames + substituted rasterized
//          text + exact-token dictionary as raw text)
//
//   2. Live retrieval scaffold (`emitLiveRequest`).
//      Emits the exact request that Babylon would send to a
//      vision-capable model for the snapcompact path: rendered frame
//      PNGs as base64 ImageContent, the exact-token dictionary as
//      raw text, the structured header, the retrieval questions.
//      If `BABYLON_LIVE_MODEL_URL` and `BABYLON_LIVE_MODEL_KEY` are
//      set, the harness POSTs the request and records the model's
//      answers (exact-match graded; semantic questions graded
//      offline). Otherwise the harness skips the live run and
//      surfaces the request to `docs/perf/snapcompact-live-request.json`
//      for offline grading.
//
// The harness is deterministic, self-contained, and does not require
// network. It is the basis for the benchmark/evaluation report.

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { serializeTranscript } from "./serializer";
import { extractHighValueTokens } from "./symbol-dictionary";
import { renderFrames, applySubstitution } from "./renderer";
import { profileForModel, type SnapcompactModelProfile } from "./model-profiles";
import { EVAL_FIXTURES, type EvalFixture, type EvalQuestion } from "./eval-fixtures";

export interface CoverageMetrics {
  /** Identifier of the projection ("raw", "prefix-control", "snapcompact", "snapcompact-dict"). */
  strategy: "raw" | "prefix-control" | "snapcompact" | "snapcompact-dict";
  sourceTextChars: number;
  /** Chars the model sees as raw text in the projection. */
  rasterizedTextChars: number;
  /** Chars in the exact-token dictionary block. */
  dictionaryTextChars: number;
  frameCount: number;
  frameBytes: number;
  imageTokenEstimate: number;
  /** Approximate total request size in bytes (raw text + base64 image bytes). */
  totalRequestBytes: number;
  /** Approximate total request size in tokens (raw + image tokens). */
  totalTokenEstimate: number;
  buildMs: number;
  truncated: boolean;
  /** Did the frame plan leave silent holes? (lines not assigned to any frame and not in omittedTrailing) */
  hasSilentHoles: boolean;
  /** Does the exact-token dictionary contain the expected raw anchors? */
  dictionaryHasExpectedAnchors: boolean;
}

export interface CoverageReport {
  fixtureId: string;
  description: string;
  metrics: CoverageMetrics[];
  /** Truthful coverage of the snapcompact archive: kept range and omitted entries. */
  archiveCoverage: {
    firstKeptEntryId: string | null;
    lastKeptEntryId: string | null;
    keptCount: number;
    omittedCount: number;
  };
}

const TOKEN_PER_CHAR = 0.25; // rough heuristic for raw English text
const PREFIX_CONTROL_CHARS = 1500;

interface ProjInputs {
  sourceText: string;
  serialized: ReturnType<typeof serializeTranscript>;
  rendered: ReturnType<typeof renderFrames>;
  profile: SnapcompactModelProfile;
  t0: number;
  t1: number;
  t2: number;
  frameBytes: number;
  imageTokens: number;
}

function projectRaw(_p: ProjInputs): CoverageMetrics {
  const chars = _p.sourceText.length;
  return {
    strategy: "raw",
    sourceTextChars: chars,
    rasterizedTextChars: chars,
    dictionaryTextChars: 0,
    frameCount: 0,
    frameBytes: 0,
    imageTokenEstimate: 0,
    totalRequestBytes: chars,
    totalTokenEstimate: Math.round(chars * TOKEN_PER_CHAR),
    buildMs: _p.t1 - _p.t0,
    truncated: _p.serialized.truncated,
    hasSilentHoles: false,
    dictionaryHasExpectedAnchors: false,
  };
}

function projectPrefixControl(p: ProjInputs): CoverageMetrics {
  const chars = p.sourceText.slice(0, PREFIX_CONTROL_CHARS);
  return {
    strategy: "prefix-control",
    sourceTextChars: p.sourceText.length,
    rasterizedTextChars: chars.length,
    dictionaryTextChars: 0,
    frameCount: 0,
    frameBytes: 0,
    imageTokenEstimate: 0,
    totalRequestBytes: chars.length,
    totalTokenEstimate: Math.round(chars.length * TOKEN_PER_CHAR),
    buildMs: 0,
    truncated: true,
    hasSilentHoles: false,
    dictionaryHasExpectedAnchors: false,
  };
}

function projectSnapcompact(p: ProjInputs, includeDictionary: boolean): CoverageMetrics {
  const symbols = p.rendered.symbols;
  const dictionaryText = symbols.map((s) => `${s.id}=${s.value}`).join("\n");
  const substituted = p.rendered.adjustedSourceText;
  const rawTextBlock = includeDictionary ? substituted + "\n" + dictionaryText : substituted;
  const imageBytes = p.frameBytes;
  // base64 of the PNG bytes is 4/3 the raw size.
  const base64ImageBytes = Math.ceil((imageBytes * 4) / 3);
  const totalRequestBytes = rawTextBlock.length + base64ImageBytes;
  const totalTokenEstimate = Math.round(rawTextBlock.length * TOKEN_PER_CHAR) + p.imageTokens;
  // Silent-holes check: the plan's linesAssigned + omission range
  // should equal totalLines. The plan exposed `omitted.marker` and
  // `linesAssigned`; if there is a marker, the omission frame is
  // present.
  const hasSilentHoles = !!p.rendered.plan.omitted.marker === false && p.rendered.plan.linesAssigned < p.rendered.plan.totalLines;
  // The dictionary is a raw-text channel; the test fixture's
  // question set is graded against the raw text + dictionary block
  // (offline coverage does NOT search the rasterized text — only the
  // dictionary and the raw source text are searchable for the
  // "does the projection contain X" check; the rasterized text
  // inside the frames is OCR territory and is not string-searched).
  const dictBlock = includeDictionary ? dictionaryText : "";
  const dictHas = symbols.length > 0 && symbols.every((s) => dictBlock.includes(s.value));
  return {
    strategy: includeDictionary ? "snapcompact-dict" : "snapcompact",
    sourceTextChars: p.sourceText.length,
    rasterizedTextChars: substituted.length,
    dictionaryTextChars: dictionaryText.length,
    frameCount: p.rendered.frames.length,
    frameBytes: p.frameBytes,
    imageTokenEstimate: p.imageTokens,
    totalRequestBytes,
    totalTokenEstimate,
    buildMs: p.t2 - p.t0,
    truncated: p.rendered.truncated,
    hasSilentHoles,
    dictionaryHasExpectedAnchors: dictHas,
  };
}

export function evaluateCoverage(fixture: EvalFixture, modelHint?: { provider?: string; id?: string }): CoverageReport {
  const profile = profileForModel(modelHint ?? { id: "generic-vision" });
  const t0 = performance.now();
  const serialized = serializeTranscript({ messages: fixture.messages });
  const t1 = performance.now();
  const rawSymbols = extractHighValueTokens(serialized.sourceText);
  const rendered = renderFrames({
    sourceText: serialized.sourceText,
    rawSymbols,
    profile: {
      id: profile.id, width: profile.width, height: profile.height,
      fontScale: profile.fontScale, lineGap: profile.lineGap,
      marginX: profile.marginX, marginY: profile.marginY,
      maxFrames: profile.maxFrames,
    },
  });
  const t2 = performance.now();
  const frameBytes = rendered.frames.reduce((n, f) => n + f.png.length, 0);
  const imageTokens = rendered.frames.length * profile.imageTokenEstimate;
  const p: ProjInputs = {
    sourceText: serialized.sourceText,
    serialized,
    rendered,
    profile,
    t0, t1, t2,
    frameBytes, imageTokens,
  };
  return {
    fixtureId: fixture.id,
    description: fixture.description,
    metrics: [projectRaw(p), projectPrefixControl(p), projectSnapcompact(p, false), projectSnapcompact(p, true)],
    archiveCoverage: {
      firstKeptEntryId: serialized.firstKeptEntryId,
      lastKeptEntryId: serialized.lastKeptEntryId,
      keptCount: serialized.keptCount,
      omittedCount: serialized.omittedTrailing.length,
    },
  };
}

export function evaluateAllCoverage(modelHint?: { provider?: string; id?: string }): CoverageReport[] {
  return EVAL_FIXTURES.map((f) => evaluateCoverage(f, modelHint));
}

export function formatCoverageReport(reports: CoverageReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(`fixture=${r.fixtureId} :: ${r.description}`);
    lines.push(`  archiveCoverage: kept=${r.archiveCoverage.keptCount} first=${r.archiveCoverage.firstKeptEntryId ?? "?"} last=${r.archiveCoverage.lastKeptEntryId ?? "?"} omitted=${r.archiveCoverage.omittedCount}`);
    for (const m of r.metrics) {
      lines.push(
        `  ${m.strategy.padEnd(16)} ` +
        `chars=${String(m.rasterizedTextChars).padStart(6)} ` +
        `dictChars=${String(m.dictionaryTextChars).padStart(6)} ` +
        `frames=${String(m.frameCount).padStart(2)} ` +
        `frameBytes=${String(m.frameBytes).padStart(7)} ` +
        `imgTokens=${String(m.imageTokenEstimate).padStart(5)} ` +
        `reqBytes=${String(m.totalRequestBytes).padStart(7)} ` +
        `reqTok=${String(m.totalTokenEstimate).padStart(6)} ` +
        `buildMs=${m.buildMs.toFixed(1)} ` +
        `trunc=${m.truncated ? "Y" : "N"} ` +
        `holes=${m.hasSilentHoles ? "Y" : "N"} ` +
        `dictOK=${m.dictionaryHasExpectedAnchors ? "Y" : "N"}`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Live retrieval scaffold
// ---------------------------------------------------------------------------

export interface LiveRequestFrame {
  index: number;
  width: number;
  height: number;
  /** base64-encoded PNG bytes. */
  base64: string;
  /** Source-text line range this frame renders (or "omission-marker"). */
  lineStart: number;
  lineEnd: number;
  carriesOmission: boolean;
}

export interface LiveRequest {
  fixtureId: string;
  description: string;
  /** System text: the snapcompact header (raw text). */
  headerText: string;
  /** Frame PNGs as real Pi ImageContent (base64 + mimeType). */
  frames: LiveRequestFrame[];
  /** Exact-token dictionary as raw text. */
  dictionaryText: string;
  /** Source coverage: kept range and omitted entries. */
  archiveCoverage: CoverageReport["archiveCoverage"];
  /** Retrieval questions (exact + semantic). */
  questions: EvalQuestion[];
  /** Approximate request size. */
  totalRequestBytes: number;
}

export function emitLiveRequest(fixture: EvalFixture, modelHint?: { provider?: string; id?: string }): LiveRequest {
  const profile = profileForModel(modelHint ?? { id: "generic-vision" });
  const serialized = serializeTranscript({ messages: fixture.messages });
  const rawSymbols = extractHighValueTokens(serialized.sourceText);
  const rendered = renderFrames({
    sourceText: serialized.sourceText,
    rawSymbols,
    profile: {
      id: profile.id, width: profile.width, height: profile.height,
      fontScale: profile.fontScale, lineGap: profile.lineGap,
      marginX: profile.marginX, marginY: profile.marginY,
      maxFrames: profile.maxFrames,
    },
  });
  const symbols = rendered.symbols;
  const dictionaryText = symbols.map((s) => `${s.id}=${s.value}`).join("\n");
  const head = rendered.adjustedSourceText.length > 1200 ? rendered.adjustedSourceText.slice(0, 1200) : rendered.adjustedSourceText;
  const tailStart = Math.max(0, rendered.adjustedSourceText.length - 1200);
  const tail = rendered.adjustedSourceText.length > 1200 ? rendered.adjustedSourceText.slice(tailStart) : "";
  const headerText = [
    "[Snapcompact archive] profile=" + profile.id,
    `frames=${rendered.frames.length} imageTokens~=${rendered.frames.length * profile.imageTokenEstimate}`,
    "--- archive head ---",
    head,
    "--- archive tail ---",
    tail || "(empty)",
    "--- exact-token dictionary ---",
    dictionaryText || "(no symbols)",
    "--- end snapcompact ---",
  ].join("\n");
  const frames: LiveRequestFrame[] = rendered.frames.map((f, i) => ({
    index: i,
    width: f.width,
    height: f.height,
    base64: f.png.toString("base64"),
    lineStart: rendered.plan.entries[i]?.lineStart ?? -1,
    lineEnd: rendered.plan.entries[i]?.lineEnd ?? -1,
    carriesOmission: rendered.plan.entries[i]?.carriesOmission ?? false,
  }));
  const totalRequestBytes = headerText.length + dictionaryText.length + frames.reduce((n, f) => n + Math.ceil((f.base64.length * 3) / 4), 0);
  return {
    fixtureId: fixture.id,
    description: fixture.description,
    headerText,
    frames,
    dictionaryText,
    archiveCoverage: {
      firstKeptEntryId: serialized.firstKeptEntryId,
      lastKeptEntryId: serialized.lastKeptEntryId,
      keptCount: serialized.keptCount,
      omittedCount: serialized.omittedTrailing.length,
    },
    questions: fixture.questions,
    totalRequestBytes,
  };
}

export interface LiveRunConfig {
  url: string;
  apiKey: string;
  model: string;
  outPath: string;
}

export interface LiveRunResult {
  fixtureId: string;
  requestPath: string;
  ran: boolean;
  answers?: Array<{ question: string; expected: string; modelAnswer: string; exact?: boolean }>;
  error?: string;
}

export async function runLiveRetrieval(req: LiveRequest, cfg: LiveRunConfig): Promise<LiveRunResult> {
  await fsp.mkdir(join(cfg.outPath, "snapcompact"), { recursive: true });
  const requestPath = join(cfg.outPath, "snapcompact", `${req.fixtureId}-request.json`);
  await fsp.writeFile(requestPath, JSON.stringify(req, null, 2), "utf8");
  if (!cfg.url || !cfg.apiKey || !cfg.model) {
    return { fixtureId: req.fixtureId, requestPath, ran: false };
  }
  // Build an OpenAI-compatible chat completions request with the
  // header as a text message and each frame as an image_url.
  const content: any[] = [{ type: "text", text: req.headerText }];
  for (const f of req.frames) {
    content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${f.base64}` } });
  }
  const userContent: any[] = [...content, { type: "text", text: questionsPrompt(req.questions) }];
  const body = {
    model: cfg.model,
    messages: [
      { role: "user", content: userContent },
    ],
    max_tokens: 1024,
  };
  try {
    const resp = await fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    const json = await resp.json() as any;
    const text = json?.choices?.[0]?.message?.content ?? "";
    const parsed = parseModelAnswers(text, req.questions);
    return { fixtureId: req.fixtureId, requestPath, ran: true, answers: parsed };
  } catch (err: any) {
    return { fixtureId: req.fixtureId, requestPath, ran: true, error: err?.message ?? String(err) };
  }
}

function questionsPrompt(questions: EvalQuestion[]): string {
  const lines: string[] = [
    "Answer each of the following questions using ONLY the information in the attached archive (header, exact-token dictionary, and the bitmap frames).",
    "Reply with a JSON object whose keys are the question numbers and whose values are the answers. Do not include any other text.",
    "",
    "Questions:",
  ];
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. (${q.kind}) ${q.prompt}`);
  });
  return lines.join("\n");
}

function parseModelAnswers(text: string, questions: EvalQuestion[]): Array<{ question: string; expected: string; modelAnswer: string; exact?: boolean }> {
  const out: Array<{ question: string; expected: string; modelAnswer: string; exact?: boolean }> = [];
  let parsed: Record<string, string> = {};
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    parsed = {};
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const modelAnswer = (parsed[String(i + 1)] ?? "").toString();
    let exact: boolean | undefined;
    if (q.exact) exact = q.exact.some((a) => modelAnswer.includes(a));
    out.push({ question: q.prompt, expected: q.semanticAnswer ?? (q.exact?.join(" | ") ?? ""), modelAnswer, exact });
  }
  return out;
}
