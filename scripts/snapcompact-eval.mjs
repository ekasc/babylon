#!/usr/bin/env node
// Snapcompact evaluation driver.
//
// Runs the coding-history evaluation harness against the bundled
// fixtures and prints a deterministic, model-free report. Semantic
// questions are included with their expected model answers so a human
// (or a separate LLM grading script) can score them offline.
//
// Run with:
//   tsx scripts/snapcompact-eval.mjs

import { evaluateAll, formatReport } from "../electron/snapcompact/eval.ts";

const reports = evaluateAll();
console.log(formatReport(reports));
