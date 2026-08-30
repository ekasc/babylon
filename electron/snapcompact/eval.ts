// Coding-history evaluation harness for snapcompact.
//
// Given the synthetic fixtures in `eval-fixtures.ts`, runs four
// strategies and reports comparable metrics:
//
//   - raw text baseline: the serialized transcript as plain text
//   - existing summary:   the existing textual recap (best-effort,
//                          here simulated as the recap delta text)
//   - snapcompact:        the bitmap archive (frames + symbol dictionary)
//   - snapcompact + dict: the bitmap archive with the exact-token
//                          dictionary preserved as raw text alongside it
//
// The harness grades exact-match questions (paths, shas, identifiers,
// versions, branches, ports, commands, rules) by checking whether the
// projected context contains each accepted answer. Semantic questions
// are emitted with the expected model answer and graded offline by a
// model; the harness reports them separately so the user can run an
// LLM over them out of band.
//
// This is a self-contained, deterministic harness. It does not call an
// LLM and does not need a network. It is the basis for the
// benchmark/evaluation report required by the spec.

import { serializeTranscript } from "./serializer";
import { extractHighValueTokens } from "./symbol-dictionary";
import { renderFrames, applySubstitution } from "./renderer";
import { profileForModel } from "./model-profiles";
import { EVAL_FIXTURES, type EvalFixture, type EvalQuestion } from "./eval-fixtures";

export interface StrategyMetrics {
  strategy: "raw" | "summary" | "snapcompact" | "snapcompact-dict";
  sourceTextChars: number;
  rasterizedTextChars: number;
  dictionaryTextChars: number;
  frameCount: number;
  frameBytes: number;
  imageTokenEstimate: number;
  totalTokenEstimate: number;
  buildMs: number;
  truncated: boolean;
  /** Per-kind exact-match accuracy (0..1). */
  exactAccuracy: Record<string, { hit: number; total: number }>;
  /** Whether every exact-match answer is present in the projection. */
  allExactAnswersPresent: boolean;
  /** Free-form answers for semantic questions, to grade offline. */
  semanticAnswers: Array<{ question: string; expected: string; projectionExcerpt: string }>;
}

export interface EvalReport {
  fixtureId: string;
  description: string;
  metrics: StrategyMetrics[];
}

const TOKEN_PER_CHAR = 0.25; // rough heuristic for English text

function gradeExact(questions: EvalQuestion[], projection: string): { exact: Record<string, { hit: number; total: number }>; all: boolean } {
  const exact: Record<string, { hit: number; total: number }> = {};
  let all = true;
  for (const q of questions) {
    if (q.kind === "semantic") continue;
    if (q.exact === undefined) continue;
    const slot = (exact[q.kind] ??= { hit: 0, total: 0 });
    slot.total += 1;
    const hit = q.exact.some((answer) => projection.includes(answer));
    if (hit) slot.hit += 1;
    else all = false;
  }
  return { exact, all };
}

function semanticExcerpt(projection: string, question: string, max = 220): string {
  if (!projection) return "";
  const idx = projection.toLowerCase().indexOf(question.toLowerCase().slice(0, 24));
  if (idx < 0) return projection.slice(0, max);
  const start = Math.max(0, idx - 40);
  return projection.slice(start, Math.min(projection.length, start + max));
}

export function evaluateFixture(fixture: EvalFixture, modelHint?: { provider?: string; id?: string }): EvalReport {
  const profile = profileForModel(modelHint ?? { id: "generic-vision" });

  // Strategy 1: raw text baseline.
  const t0 = performance.now();
  const serialized = serializeTranscript({ messages: fixture.messages });
  const rawProjection = serialized.sourceText;
  const rawExact = gradeExact(fixture.questions, rawProjection);
  const t1 = performance.now();
  const rawStrategy: StrategyMetrics = {
    strategy: "raw",
    sourceTextChars: rawProjection.length,
    rasterizedTextChars: rawProjection.length,
    dictionaryTextChars: 0,
    frameCount: 0,
    frameBytes: 0,
    imageTokenEstimate: 0,
    totalTokenEstimate: Math.round(rawProjection.length * TOKEN_PER_CHAR),
    buildMs: t1 - t0,
    truncated: serialized.truncated,
    exactAccuracy: rawExact.exact,
    allExactAnswersPresent: rawExact.all,
    semanticAnswers: fixture.questions.filter((q) => q.kind === "semantic" && q.semanticAnswer).map((q) => ({
      question: q.prompt,
      expected: q.semanticAnswer!,
      projectionExcerpt: semanticExcerpt(rawProjection, q.prompt),
    })),
  };

  // Strategy 2: existing textual compaction (recap) — represented by the
  // first 1500 characters of the serialized source. The actual recap is
  // an LLM-generated summary line; for the harness we use a deterministic
  // surrogate that bounds the same number of source characters a single
  // recap would cover.
  const summaryProjection = rawProjection.slice(0, 1500);
  const summaryExact = gradeExact(fixture.questions, summaryProjection);
  const summaryStrategy: StrategyMetrics = {
    strategy: "summary",
    sourceTextChars: rawProjection.length,
    rasterizedTextChars: summaryProjection.length,
    dictionaryTextChars: 0,
    frameCount: 0,
    frameBytes: 0,
    imageTokenEstimate: 0,
    totalTokenEstimate: Math.round(summaryProjection.length * TOKEN_PER_CHAR),
    buildMs: 0,
    truncated: true,
    exactAccuracy: summaryExact.exact,
    allExactAnswersPresent: summaryExact.all,
    semanticAnswers: fixture.questions.filter((q) => q.kind === "semantic" && q.semanticAnswer).map((q) => ({
      question: q.prompt,
      expected: q.semanticAnswer!,
      projectionExcerpt: semanticExcerpt(summaryProjection, q.prompt),
    })),
  };

  // Strategy 3: snapcompact.
  const rawSymbols = extractHighValueTokens(serialized.sourceText);
  const rendered = renderFrames({ sourceText: serialized.sourceText, rawSymbols, profile: { id: profile.id, width: profile.width, height: profile.height, fontScale: profile.fontScale, lineGap: profile.lineGap, marginX: profile.marginX, marginY: profile.marginY, maxFrames: profile.maxFrames } });
  const t2 = performance.now();
  const frameBytes = rendered.frames.reduce((n, f) => n + f.png.length, 0);
  const imageTokens = rendered.frames.length * profile.imageTokenEstimate;
  // The model still sees the recent raw conversation in the session; the
  // archive only contributes its rasterized text + image tokens. For the
  // raw-text portion the archive substitutes long values with [E001] etc.;
  // the substituted text + image tokens is the archive's contribution.
  const snapProjection = rendered.adjustedSourceText;
  const snapExact = gradeExact(fixture.questions, snapProjection);
  const snapStrategy: StrategyMetrics = {
    strategy: "snapcompact",
    sourceTextChars: rawProjection.length,
    rasterizedTextChars: snapProjection.length,
    dictionaryTextChars: 0,
    frameCount: rendered.frames.length,
    frameBytes,
    imageTokenEstimate: imageTokens,
    totalTokenEstimate: Math.round(snapProjection.length * TOKEN_PER_CHAR) + imageTokens,
    buildMs: t2 - t0,
    truncated: rendered.truncated,
    exactAccuracy: snapExact.exact,
    allExactAnswersPresent: snapExact.all,
    semanticAnswers: fixture.questions.filter((q) => q.kind === "semantic" && q.semanticAnswer).map((q) => ({
      question: q.prompt,
      expected: q.semanticAnswer!,
      projectionExcerpt: semanticExcerpt(snapProjection, q.prompt),
    })),
  };

  // Strategy 4: snapcompact + exact-token dictionary. The dictionary is
  // raw text the model sees alongside the images, so its content is
  // directly available for exact-match. The rasterized text may have
  // substituted the long values; the dictionary carries them.
  const dictText = rendered.symbols.map((s) => `${s.id}=${s.value}`).join("; ");
  const dictProjection = snapProjection + "\n" + dictText;
  const dictExact = gradeExact(fixture.questions, dictProjection);
  const dictStrategy: StrategyMetrics = {
    strategy: "snapcompact-dict",
    sourceTextChars: rawProjection.length,
    rasterizedTextChars: snapProjection.length,
    dictionaryTextChars: dictText.length,
    frameCount: rendered.frames.length,
    frameBytes,
    imageTokenEstimate: imageTokens,
    totalTokenEstimate: Math.round(snapProjection.length * TOKEN_PER_CHAR) + imageTokens + Math.round(dictText.length * TOKEN_PER_CHAR),
    buildMs: t2 - t0,
    truncated: rendered.truncated,
    exactAccuracy: dictExact.exact,
    allExactAnswersPresent: dictExact.all,
    semanticAnswers: fixture.questions.filter((q) => q.kind === "semantic" && q.semanticAnswer).map((q) => ({
      question: q.prompt,
      expected: q.semanticAnswer!,
      projectionExcerpt: semanticExcerpt(dictProjection, q.prompt),
    })),
  };

  return {
    fixtureId: fixture.id,
    description: fixture.description,
    metrics: [rawStrategy, summaryStrategy, snapStrategy, dictStrategy],
  };
}

export function evaluateAll(modelHint?: { provider?: string; id?: string }): EvalReport[] {
  return EVAL_FIXTURES.map((f) => evaluateFixture(f, modelHint));
}

export function formatReport(reports: EvalReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(`fixture=${r.fixtureId} :: ${r.description}`);
    for (const m of r.metrics) {
      const exact = Object.entries(m.exactAccuracy)
        .map(([k, v]) => `${k}=${v.hit}/${v.total}`).join(" ") || "none";
      lines.push(
        `  ${m.strategy.padEnd(16)} ` +
        `chars=${String(m.rasterizedTextChars).padStart(6)} ` +
        `dictChars=${String(m.dictionaryTextChars).padStart(6)} ` +
        `frames=${String(m.frameCount).padStart(2)} ` +
        `frameBytes=${String(m.frameBytes).padStart(7)} ` +
        `imgTokens=${String(m.imageTokenEstimate).padStart(5)} ` +
        `totalTok=${String(m.totalTokenEstimate).padStart(6)} ` +
        `buildMs=${m.buildMs.toFixed(1)} ` +
        `trunc=${m.truncated ? "Y" : "N"} ` +
        `allExact=${m.allExactAnswersPresent ? "Y" : "N"} ` +
        `[${exact}]`
      );
      for (const sa of m.semanticAnswers) {
        lines.push(`    semantic q: ${sa.question}`);
        lines.push(`      expected: ${sa.expected}`);
        lines.push(`      excerpt:  ${sa.projectionExcerpt.replace(/\n/g, " ")}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
