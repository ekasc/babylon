// Deterministic transcript serializer for Snapcompact.
//
// Given projected messages (typically CompactionPreparation.messagesToSummarize
// + turnPrefixMessages), produces:
//   - a compact source text with explicit structural markers a vision
//     model can visually parse (¶user / ¶assistant / ¶thinking / ¶tool / ¶result / ¶custom)
//   - truthful coverage metadata derived from what was actually retained
//   - a list of exact high-value tokens (paths, shas, ...) that the symbol
//     dictionary will later assign (handled by symbol-dictionary.ts)
//
// Coverage contract: the source text contains exactly the kept-message
// texts in order. When the total source budget forces entries to be
// dropped, the dropped entries are recorded in `omittedTrailing` and the
// kept range is reported via `firstKeptEntryId` / `lastKeptEntryId`. The
// serializer never truncates the middle of a kept entry's text and never
// claims coverage of an entry that was not serialized.
//
// Rules enforced here (no LLM, deterministic):
//   - chronological order, one block per role
//   - tool calls remain paired with their results (same toolCallId)
//   - errors / failures are preserved
//   - relevant code / diffs / log excerpts are preserved
//   - embedded image / base64 payloads are stripped
//   - pathological individual tool results are deterministically truncated
//     with an explicit marker
//   - the total source budget is applied by dropping whole messages
//     (chronological: drop newest first) so coverage is honest
//   - never let one command output consume the entire archive

import { extractHighValueTokens, type RawSymbol } from "./symbol-dictionary";

export const MARKER = {
  user: "\u00b6user",
  assistant: "\u00b6assistant",
  thinking: "\u00b6thinking",
  tool: "\u00b6tool",
  result: "\u00b6result",
  custom: "\u00b6custom",
} as const;

export const PER_TOOL_RESULT_BUDGET = 4_000;
export const TOTAL_BUDGET_CHARS = 60_000;
export const OMITTED_TAIL_LINES = 0;

export interface SerializeInput {
  messages: any[];
  perToolResultBudget?: number;
  totalBudget?: number;
}

export interface OmittedEntry {
  entryId: string;
  role: string;
  reason: "tool-result-image-only" | "total-budget";
}

export interface SerializeOutput {
  sourceText: string;
  rawSymbols: RawSymbol[];
  truncated: boolean;
  skipped: number;
  firstKeptEntryId: string | null;
  lastKeptEntryId: string | null;
  keptCount: number;
  omittedTrailing: OmittedEntry[];
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (!b) return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "thinking" && typeof b.thinking === "string") return b.thinking;
      if (b.type === "image") return "";
      if (typeof b.text === "string") return b.text;
      return "";
    })
    .join("");
}

function hasImagePayload(content: any): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b: any) => b?.type === "image");
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, Math.max(0, max - 64)) + "\n\u2026 [truncated " + (s.length - max) + " chars]", truncated: true };
}

function formatHeader(marker: string, label?: string): string {
  return label ? `${marker} ${label}` : marker;
}

function serializeAssistant(msg: any): string {
  const blocks: string[] = [];
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!b) continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        blocks.push(b.text.trimEnd());
      } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        blocks.push(formatHeader(MARKER.thinking) + "\n" + b.thinking.trimEnd());
      }
    }
  } else if (typeof msg.content === "string" && msg.content.trim()) {
    blocks.push(msg.content.trimEnd());
  }
  const tools: { id: string; name: string; args: string }[] = [];
  if (Array.isArray(msg.toolCalls)) {
    for (const tc of msg.toolCalls) {
      if (!tc?.id) continue;
      const name = String(tc.name ?? "tool");
      let args = tc.arguments;
      if (typeof args !== "string") {
        try { args = JSON.stringify(args ?? {}, null, 0); } catch { args = String(args); }
      }
      tools.push({ id: String(tc.id), name, args: String(args) });
    }
  }
  const header = formatHeader(MARKER.assistant, msg.model ? `model=${msg.model}` : undefined);
  const out: string[] = [header];
  for (const block of blocks) out.push(block);
  for (const t of tools) {
    out.push(`${MARKER.tool} ${t.name}`);
    out.push(t.args);
  }
  return out.join("\n");
}

function serializeToolResult(msg: any, budget: number): { text: string; skipped: boolean } {
  if (Array.isArray(msg.content) && hasImagePayload(msg.content) && !msg.content.some((b: any) => b?.type === "text")) {
    return { text: "", skipped: true };
  }
  const text = textOf(msg.content);
  if (!text.trim()) return { text: "", skipped: true };
  const label = msg.isError ? `${MARKER.result} error` : MARKER.result;
  const t = truncate(text, budget);
  const tag = msg.truncated || t.truncated ? " [truncated]" : "";
  return { text: `${label}${tag}\n${t.text}`, skipped: false };
}

function serializeUser(msg: any): string {
  if (hasImagePayload(msg.content) && !textOf(msg.content).trim()) {
    return "";
  }
  return formatHeader(MARKER.user) + "\n" + textOf(msg.content).trimEnd();
}

function serializeCustom(msg: any): string {
  const label = msg.customType ? `${MARKER.custom} ${msg.customType}` : MARKER.custom;
  return `${label}\n${textOf(msg.content).trimEnd()}`;
}

function entryIdOf(msg: any): string {
  if (typeof msg?.entryId === "string" && msg.entryId) return msg.entryId;
  return "?";
}

function entryRoleOf(msg: any): string {
  return typeof msg?.role === "string" ? msg.role : "?";
}

/**
 * Serialize a list of projected messages. The total source budget is
 * applied by keeping the most-recent suffix that fits and dropping
 * the oldest entries, so coverage is honest: every line of
 * `sourceText` corresponds to a real entry, and the dropped entries
 * are reported in `omittedTrailing`. Recent context is prioritized
 * because a context archive that drops the newest turns loses the
 * information most likely to be queried next.
 */
export function serializeTranscript(input: SerializeInput): SerializeOutput {
  const perTool = input.perToolResultBudget ?? PER_TOOL_RESULT_BUDGET;
  const totalBudget = input.totalBudget ?? TOTAL_BUDGET_CHARS;
  const messages = Array.isArray(input.messages) ? input.messages : [];

  // First pass: compute the would-be block for every message (or the
  // reason it's skipped). We do this before budgeting so we can drop
  // whole messages from the end instead of slicing a single string.
  const perMessage: Array<{ msg: any; block: string; skipped: boolean }> = [];
  const toolIndex = new Map<string, string>();
  let skippedCount = 0;

  for (const m of messages) {
    if (!m) continue;
    const role = m.role;
    let block = "";
    let skipped = false;
    if (role === "user") {
      block = serializeUser(m);
      if (!block) skipped = true;
    } else if (role === "assistant") {
      block = serializeAssistant(m);
      if (Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) {
          if (tc?.id) toolIndex.set(String(tc.id), String(tc.name ?? "tool"));
        }
      }
    } else if (role === "toolResult") {
      const r = serializeToolResult(m, perTool);
      if (r.skipped) skipped = true;
      else {
        const name = toolIndex.get(String(m.toolCallId)) ?? "tool";
        block = `${MARKER.tool} ${name}\n${r.text}`;
      }
    } else if (role === "custom") {
      block = serializeCustom(m);
    } else {
      skipped = true;
    }
    if (skipped) skippedCount += 1;
    perMessage.push({ msg: m, block, skipped });
  }

  // Second pass: keep the most-recent suffix that fits the total
  // budget. For an agent context archive the recent boundary is more
  // valuable; dropping prefers the oldest entries. We walk backwards.
  let totalLen = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  // Find last non-skipped index
  for (let i = perMessage.length - 1; i >= 0; i--) {
    if (!perMessage[i].skipped) { lastIdx = i; break; }
  }
  if (lastIdx !== -1) {
    for (let i = lastIdx; i >= 0; i--) {
      const item = perMessage[i];
      if (item.skipped) continue;
      const sep = totalLen === 0 ? 0 : 2;
      const added = item.block.length + sep;
      if (totalLen + added > totalBudget) break;
      totalLen += added;
      firstIdx = i;
    }
  }

  // If nothing fits, return empty coverage.
  if (firstIdx < 0) {
    const rawSymbols = extractHighValueTokens("");
    return {
      sourceText: "",
      rawSymbols,
      truncated: false,
      skipped: skippedCount,
      firstKeptEntryId: null,
      lastKeptEntryId: null,
      keptCount: 0,
      omittedTrailing: [],
    };
  }

  const kept: string[] = [];
  for (let i = firstIdx; i <= lastIdx; i++) {
    if (!perMessage[i].skipped) kept.push(perMessage[i].block);
  }
  const sourceText = kept.join("\n\n");
  const omittedTrailing: OmittedEntry[] = [];
  // Dropped due to budget: oldest non-skipped entries before firstIdx
  for (let i = 0; i < firstIdx; i++) {
    const item = perMessage[i];
    if (item.skipped) continue;
    omittedTrailing.push({ entryId: entryIdOf(item.msg), role: entryRoleOf(item.msg), reason: "total-budget" });
  }
  // Also record image-only / empty messages as omitted (skipped before budgeting).
  for (const item of perMessage) {
    if (item.skipped) {
      omittedTrailing.push({ entryId: entryIdOf(item.msg), role: entryRoleOf(item.msg), reason: "tool-result-image-only" });
    }
  }
  const truncated = omittedTrailing.some((o) => o.reason === "total-budget");

  const rawSymbols = extractHighValueTokens(sourceText);
  return {
    sourceText,
    rawSymbols,
    truncated,
    skipped: skippedCount,
    firstKeptEntryId: entryIdOf(perMessage[firstIdx].msg),
    lastKeptEntryId: entryIdOf(perMessage[lastIdx].msg),
    keptCount: kept.length,
    omittedTrailing,
  };
}
