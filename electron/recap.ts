/**
 * Auto-recap: after a chat has been quiet for RECAP_INTERVAL_MS, summarize the
 * conversation since the previous recap (or since the start) with a cheap
 * model, stored as a Babylon-owned annotation and rendered as a "Recap: …"
 * system line. Pure logic lives here so the sweep and delta selection are
 * unit-testable; persistence lives in RecapStore.
 */

import { parseRoomTurn } from "../src/bots";

export interface Recap {
  id: string;
  /** ISO timestamp of when the recap was generated. */
  at: string;
  /** entryId of the last conversation entry the recap covers (delta anchor). */
  coveredEntryId: string | null;
  /** Rendered line, already prefixed with "Recap: ". */
  text: string;
}

export const RECAP_INTERVAL_MS = 2 * 60_000;
export const RECAP_MAX_DELTA_CHARS = 8000;
/** Recent stretch a recap covers when there is no prior anchor to start from. */
export const RECAP_MAX_DELTA_MESSAGES = 20;
export const RECAP_MIN_MESSAGES = 2;
export const RECAP_MIN_CHARS = 400;

/** True when a recap is due: the chat's last message is older than the
 *  interval and no recap already covers that stretch. */
export function recapDue(
  lastMessageAt: number,
  lastRecapAt: number | null,
  now: number,
  intervalMs = RECAP_INTERVAL_MS
): boolean {
  if (!lastMessageAt || now - lastMessageAt < intervalMs) return false;
  return lastRecapAt === null || lastRecapAt < lastMessageAt;
}

/** Picks the projected messages (with `entryId` attached) a recap should
 *  cover: everything after the previous recap's anchor when one exists,
 *  otherwise the most recent stretch of the conversation (so a first recap
 *  summarizes recent changes rather than the whole chat). */
export function pickRecapDelta(
  messages: any[],
  coveredEntryId: string | null,
  maxMessages = RECAP_MAX_DELTA_MESSAGES
): { messages: any[]; coveredEntryId: string | null } {
  let start = 0;
  if (coveredEntryId) {
    const anchor = messages.findIndex((m) => m.entryId === coveredEntryId);
    if (anchor >= 0) start = anchor + 1;
    else start = Math.max(0, messages.length - maxMessages);
  } else {
    start = Math.max(0, messages.length - maxMessages);
  }
  const window = messages.slice(start);
  return { messages: window, coveredEntryId: window.length ? window[window.length - 1].entryId : null };
}

/** A recap is only worth a model call if there is something to say: at least a
 *  couple of turns and a real chunk of text. */
export function recapWorthy(messages: any[], minMessages = RECAP_MIN_MESSAGES, minChars = RECAP_MIN_CHARS): boolean {
  let chars = 0;
  let count = 0;
  for (const m of messages ?? []) {
    if (typeof m?.content === "string") chars += m.content.length;
    else if (Array.isArray(m?.content)) {
      for (const block of m.content) {
        if (typeof block === "string") chars += block.length;
        else chars += String(block?.text ?? "").length;
      }
    }
    count++;
    if (count >= minMessages && chars >= minChars) return true;
  }
  return false;
}

export function buildRecapPrompt(deltaText: string): string {
  return (
    "Write a brief recap of the RECENT changes and current state in this coding-assistant " +
    "conversation, the latest work done and what is next. Do not summarize the full history. " +
    'Reply with a single line starting with "Recap: " (1-3 short sentences). ' +
    "Skip greetings and chit-chat. Do not use markdown headers.\n\n" + deltaText
  );
}

/** Plain-text projection of a message window for summarization prompts.
 *  User + assistant text only, oldest first, capped. Room director prompts
 *  (user-role machinery) are machinery, not content, dropped. */
export function transcriptText(messages: any[], cap = 24_000): string {
  const parts: string[] = [];
  let chars = 0;
  for (const m of messages ?? []) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const blocks = typeof m.content === "string" ? [m.content] : Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      const text = typeof b === "string" ? b : String(b?.text ?? "");
      if (!text.trim()) continue;
      if (m.role === "user" && parseRoomTurn(text)) continue;
      parts.push(text);
      chars += text.length;
      if (chars >= cap) return parts.join("\n\n").slice(0, cap);
    }
  }
  return parts.join("\n\n");
}

/** Handoff prompt: a structured summary of a past thread, written in the
 *  continuing voice (project default persona supplied by the caller, the
 *  cheap model has no persona of its own). Explicit user action only. */
export function buildHandoffPrompt(deltaText: string, author: { name: string; persona?: string }): string {
  const voice = author.persona?.trim() ? `\nVoice notes for the summary (write in this voice): ${author.persona.trim()}` : "";
  return (
    `Summarize the following past conversation as a HANDOFF for ${author.name}, who will continue the work. ` +
    "Structure it exactly with these markdown headers: ## Goal, ## Key decisions, ## Open loops, ## Files touched. " +
    "Keep it under ~1200 words. Skip greetings and chit-chat." + voice + "\n\n" + deltaText
  );
}

/** Normalizes a handoff reply into capped markdown (multi-line, unlike recaps). */
export function normalizeHandoffText(raw: string): string | null {
  const text = (raw ?? "").trim().replace(/\n{3,}/g, "\n\n").slice(0, 6000);
  return text ? text : null;
}

/** Normalizes a model reply into a single "Recap: …" line. */
export function normalizeRecapText(raw: string): string | null {
  const text = (raw ?? "").trim().replace(/\s+/g, " ").slice(0, 400);
  if (!text) return null;
  const withoutPrefix = text.replace(/^recap\s*:\s*/i, "");
  return `Recap: ${withoutPrefix}`;
}

/** A recap renders like a custom system message so the transcript can show it
 *  interleaved by timestamp without touching the append-only session file. */
export function recapToMessage(recap: Recap): any {
  return {
    role: "custom",
    customType: "babylon_recap",
    content: recap.text,
    display: true,
    timestamp: Date.parse(recap.at),
    entryId: `recap:${recap.id}`,
  };
}

/** Merges recap annotations into a projected message window (tail or range),
 *  interleaved by timestamp. */
export function mergeRecaps(messages: any[], recaps: Recap[]): any[] {
  if (!recaps?.length) return messages;
  const extras = recaps.map(recapToMessage).filter((m) => Number.isFinite(m.timestamp));
  if (!extras.length) return messages;
  return [...messages, ...extras].sort((a, b) => {
    const at = typeof a?.timestamp === "number" ? a.timestamp : 0;
    const bt = typeof b?.timestamp === "number" ? b.timestamp : 0;
    return at - bt;
  });
}

/** Merges recaps into an OLDER transcript window: only recaps generated within
 *  the window's time span, so each recap lands in exactly one window and
 *  scroll-up history loads cannot duplicate recaps already shown nearer the
 *  tail. */
export function mergeRecapsIntoWindow(messages: any[], recaps: Recap[]): any[] {
  if (!messages.length || !recaps?.length) return messages;
  let first = Infinity;
  let last = -Infinity;
  for (const m of messages) {
    if (typeof m?.timestamp !== "number" || !Number.isFinite(m.timestamp)) continue;
    first = Math.min(first, m.timestamp);
    last = Math.max(last, m.timestamp);
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) return messages;
  const inside = recaps.filter((r) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && t >= first && t <= last;
  });
  return mergeRecaps(messages, inside);
}
