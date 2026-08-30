// Deterministic transcript serializer for Snapcompact.
//
// Given projected Pi messages, produces:
//   - a compact source text with explicit structural markers that a vision
//     model can visually parse (¶user / ¶assistant / ¶thinking / ¶tool / ¶result / ¶custom)
//   - a list of exact high-value tokens (paths, shas, ...) and IDs that the
//     symbol dictionary will later assign (handled by symbol-dictionary.ts)
//
// Rules enforced here (no LLM, deterministic):
//   - chronological order, one block per role
//   - tool calls remain paired with their results (same toolCallId)
//   - errors / failures are preserved
//   - relevant code / diffs / log excerpts are preserved
//   - embedded image / base64 payloads are stripped
//   - pathological individual tool results are deterministically truncated
//     with an explicit marker
//   - no individual tool result may exceed a per-result char budget
//   - never let one command output consume the entire archive

import { extractHighValueTokens, type RawSymbol } from "./symbol-dictionary";

/** Marker prefixes used in the serialized transcript. */
export const MARKER = {
  user: "\u00b6user",
  assistant: "\u00b6assistant",
  thinking: "\u00b6thinking",
  tool: "\u00b6tool",
  result: "\u00b6result",
  custom: "\u00b6custom",
} as const;

/** Per-tool-result character budget before truncation. */
export const PER_TOOL_RESULT_BUDGET = 4_000;

/** Total serialized text budget. */
export const TOTAL_BUDGET_CHARS = 60_000;

export interface SerializeInput {
  messages: any[];
  /** Optional override for the per-tool-result budget. */
  perToolResultBudget?: number;
  /** Optional override for the total character budget. */
  totalBudget?: number;
}

export interface SerializeOutput {
  sourceText: string;
  rawSymbols: RawSymbol[];
  /** True iff some content was truncated to fit the budget. */
  truncated: boolean;
  /** Count of messages that were skipped (e.g. raw image-only). */
  skipped: number;
}

interface ToolCallInfo {
  id: string;
  name: string;
  args: string;
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
  const tools: ToolCallInfo[] = [];
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

export function serializeTranscript(input: SerializeInput): SerializeOutput {
  const perTool = input.perToolResultBudget ?? PER_TOOL_RESULT_BUDGET;
  const totalBudget = input.totalBudget ?? TOTAL_BUDGET_CHARS;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const blocks: string[] = [];
  const toolIndex = new Map<string, string>();
  const skipped: string[] = [];
  let truncated = false;

  for (const m of messages) {
    if (!m) continue;
    const role = m.role;
    let block = "";
    if (role === "user") {
      block = serializeUser(m);
      if (!block) { skipped.push(m.entryId ?? "?"); continue; }
    } else if (role === "assistant") {
      block = serializeAssistant(m);
      if (Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) {
          if (tc?.id) toolIndex.set(String(tc.id), String(tc.name ?? "tool"));
        }
      }
    } else if (role === "toolResult") {
      const r = serializeToolResult(m, perTool);
      if (r.skipped) { skipped.push(m.entryId ?? m.toolCallId ?? "?"); continue; }
      const name = toolIndex.get(String(m.toolCallId)) ?? "tool";
      block = `${MARKER.tool} ${name}\n${r.text}`;
    } else if (role === "custom") {
      block = serializeCustom(m);
    } else {
      continue;
    }
    blocks.push(block);
  }

  let sourceText = blocks.join("\n\n");

  if (sourceText.length > totalBudget) {
    truncated = true;
    sourceText = sourceText.slice(0, Math.max(0, totalBudget - 80)) + "\n\u2026 [truncated " + (sourceText.length - totalBudget) + " chars]";
  }

  const rawSymbols = extractHighValueTokens(sourceText);
  return { sourceText, rawSymbols, truncated, skipped: skipped.length };
}
