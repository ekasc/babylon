// Chat view model + reducer for pi RPC events.
//
// Strategy: live events drive the streaming UX; on `agent_settled` (and when
// opening a session) we rebuild the transcript from `get_messages`, which is the
// source of truth. This keeps delta handling simple and self-correcting.

export interface Block {
  type: "text" | "thinking";
  text: string;
}

export type ToolStatus = "pending" | "running" | "done" | "error";

/** Babylon-wrapped bash metadata riding on tool items (command chips, exit
 *  code, duration). Validated at the wire boundary by babylonMeta. */
export interface BabylonBashMeta {
  kind: "babylon_bash";
  version: 1;
  callId: string;
  command: string;
  argv: string[];
  head: string;
  headBase: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  exitSignal?: string;
  status: "running" | "completed" | "exited" | "signaled" | "timeout" | "aborted" | "failed";
  cwd: string;
  truncated: boolean;
  fullOutputPath?: string;
  unsafe?: string | null;
  hints: Array<{ kind: "explain"; label: string; description: string }>;
  durationMs?: number;
}

/** Validate a wire payload as BabylonBashMeta. Only fully-shaped payloads
 *  pass; anything else keeps the row's existing metadata. Rebuilt field by
 *  field so extra wire keys can never ride into the transcript. */
function babylonMeta(value: unknown): BabylonBashMeta | undefined {
  const w = wireOf(value);
  if (!w || w.kind !== "babylon_bash" || w.version !== 1) return undefined;
  if (
    typeof w.callId !== "string" ||
    typeof w.command !== "string" ||
    typeof w.cwd !== "string" ||
    typeof w.head !== "string" ||
    typeof w.headBase !== "string" ||
    typeof w.startedAt !== "number" ||
    typeof w.truncated !== "boolean" ||
    !isArrayOf(w.argv, isString) ||
    !Array.isArray(w.hints)
  ) {
    return undefined;
  }
  const status = w.status;
  if (
    status !== "running" && status !== "completed" && status !== "exited" && status !== "signaled" &&
    status !== "timeout" && status !== "aborted" && status !== "failed"
  ) {
    return undefined;
  }
  const hints: Array<{ kind: "explain"; label: string; description: string }> = [];
  for (const h of w.hints) {
    const hw = wireOf(h);
    if (hw?.kind === "explain" && typeof hw.label === "string" && typeof hw.description === "string") {
      hints.push({ kind: "explain", label: hw.label, description: hw.description });
    }
  }
  return {
    kind: "babylon_bash",
    version: 1,
    callId: w.callId,
    command: w.command,
    argv: [...w.argv],
    head: w.head,
    headBase: w.headBase,
    startedAt: w.startedAt,
    ...(typeof w.endedAt === "number" ? { endedAt: w.endedAt } : {}),
    ...(typeof w.exitCode === "number" ? { exitCode: w.exitCode } : {}),
    ...(typeof w.exitSignal === "string" ? { exitSignal: w.exitSignal } : {}),
    status,
    cwd: w.cwd,
    truncated: w.truncated,
    ...(typeof w.fullOutputPath === "string" ? { fullOutputPath: w.fullOutputPath } : {}),
    ...(typeof w.unsafe === "string" || w.unsafe === null ? { unsafe: w.unsafe } : {}),
    hints,
    ...(typeof w.durationMs === "number" ? { durationMs: w.durationMs } : {}),
  };
}

/** Unvalidated object off the SDK/IPC boundary (session file entries,
 *  agent events). Every read goes through the wire* helpers (see lib/wire)
 *  so a malformed payload degrades to a default instead of throwing. */
export type { Wire } from "./lib/wire";
export { isArrayOf, isPlainObject, isRecordOf, isString, wireArr, wireNum, wireOf, wireStr } from "./lib/wire";
import { isArrayOf, isString, wireArr, wireNum, wireOf, wireStr, wireStrArr, type Wire } from "./lib/wire";

/** Tool result metadata (diff patch/file for previews). Unknown keys pass
 *  through for forward compatibility; known keys are narrowed at use. */
export type ToolDetails = {
  patch?: unknown;
  diff?: unknown;
  file?: unknown;
  babylon?: unknown;
  [key: string]: unknown;
};

export type ChatItem =
  | { kind: "user"; key: string; text: string; entryId?: string; imageCount?: number; images?: string[]; optimistic?: boolean }
  | {
      kind: "assistant";
      key: string;
      blocks: Block[];
      model?: string;
      streaming?: boolean;
      /** Group-room speaker handle (director-attributed). Drives the member header. */
      speaker?: string;
    }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
      name: string;
      args?: unknown;
      status: ToolStatus;
      output?: string;
      details?: ToolDetails;
      /** Output was clamped at the wire; a "show full" fetch is available. */
      truncated?: boolean;
      /** Babylon-wrapped tool metadata (e.g. babylon_bash command chips, exit code, duration). */
      babylon?: BabylonBashMeta;
    }
  | { kind: "system"; key: string; text: string }
  | { kind: "recap"; key: string; text: string; at: number }
  | { kind: "launch"; key: string; runKind: "subagent" | "thread" | "workflow"; runId: string; label: string; status: "running" | "completed" | "failed" | "stopped"; log?: string }
  | { kind: "compaction"; key: string; status: "compacting" | "compacted" | "aborted" | "failed"; reason?: string; result?: { tokensBefore?: number; estimatedTokensAfter?: number }; error?: string };

export type DialogMethod = "select" | "confirm" | "input" | "editor";

export interface Dialog {
  id: string;
  method: DialogMethod;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export interface Toast {
  id: number;
  type: "info" | "warning" | "error";
  text: string;
}

import { isPassReply, parseRoomTurn } from "./bots";
import type { AgentEvent } from "./bridge";

export interface RoomPresence {
  handle: string;
  phase: "started";
}

export interface State {
  items: ChatItem[];
  streaming: boolean;
  /** Wall-clock ms when the current run started (agent_start). Cleared on settle. */
  streamStartAt: number | null;
  steering: string[];
  followUp: string[];
  dialogs: Dialog[];
  toasts: Toast[];
  settledNonce: number;
  /** Live group-room turn ("@x is thinking…"). Cleared on reply/settle, never persisted. */
  roomTurn: RoomPresence | null;
}

export type Action =
  | { type: "reset" }
  | { type: "rebuild"; messages: unknown[] }
  | { type: "event"; event: AgentEvent }
  | { type: "local-user"; text: string; images?: string[] }
  | { type: "local-user-rollback"; text: string }
  | { type: "notice"; text: string }
  | { type: "dialog-dismiss"; id: string }
  | { type: "toast"; toast: Omit<Toast, "id"> }
  | { type: "toast-dismiss"; id: number };

let keySeq = 0;
const nextKey = (p: string) => `${p}${++keySeq}`;

/**
 * Stable item key derived from message identity, so `rebuild` reconciles in
 * place instead of remounting the whole transcript (which causes a visible
 * re-populate + scroll jump when the cached preview is replaced by the live
 * session's messages).
 */
function msgKey(role: string, m: unknown, index: number): string {
  const ts = fieldOf(m, "timestamp");
  return `${role}:${typeof ts === "number" || typeof ts === "string" ? ts : index}:${index}`;
}

/** Single unknown-field read (messagesToItems touches each field once). */
function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Wire)[key];
}
let toastSeq = 0;

export const initialState: State = {
  items: [],
  streaming: false,
  streamStartAt: null,
  steering: [],
  followUp: [],
  dialogs: [],
  toasts: [],
  settledNonce: 0,
  roomTurn: null,
};

export function textOf(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : (typeof c === "object" && c !== null && typeof (c as Wire).text === "string" ? (c as Wire).text as string : "")))
      .join("");
  }
  return String(content);
}

/**
 * Merges the live session view into the already-loaded transcript without
 * dropping anything on screen: only live messages newer than the last loaded
 * message are appended (timestamps are monotonic within a session). The loaded
 * file transcript stays stable, which is what keeps big-session opens free of
 * the wipe-flicker caused by pi's compacted live view replacing the tail.
 */
export function mergeLiveMessages(loaded: unknown[], live: unknown[]): unknown[] {
  const last = loaded.length ? loaded[loaded.length - 1] : null;
  const lastTs = fieldOf(last, "timestamp");
  const lastTsNum = typeof lastTs === "number" ? lastTs : 0;
  const fresh: unknown[] = [];
  for (const message of live ?? []) {
    const ts = fieldOf(message, "timestamp");
    if (typeof ts === "number" && ts > lastTsNum) fresh.push(message);
  }
  return fresh.length ? [...loaded, ...fresh] : loaded;
}

export function messagesToItems(messages: unknown[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolById = new Map<string, Extract<ChatItem, { kind: "tool" }>>();
  // Group-room machinery, collapsed at render: a director prompt addresses a
  // member (never a user bubble); a PASS reply is dropped entirely, quiet
  // members leave no trace. Nothing is dropped from the session file.
  let pendingRoomHandle: string | null = null;

  for (let messageIndex = 0; messageIndex < (messages?.length ?? 0); messageIndex++) {
    const m = messages[messageIndex];
    const wm = wireOf(m);
    switch (wm?.role) {
      case "user": {
        const text = textOf(wm?.content).trim();
        const roomHandle = parseRoomTurn(text);
        if (roomHandle) {
          pendingRoomHandle = roomHandle;
          break;
        }
        pendingRoomHandle = null;
        const images: string[] = [];
        const content = wireArr(wm, "content");
        if (content) {
          for (const b of content) {
            const wb = wireOf(b);
            if (wb?.type === "image") {
              const data = wireStr(wb, "data") ?? wireStr(wireOf(wb.source), "data");
              const mime = wireStr(wb, "mimeType") ?? wireStr(wireOf(wb.source), "mediaType") ?? "image/png";
              if (data) images.push(`data:${mime};base64,${data}`);
            }
          }
        }
        for (const a of wireArr(wm, "attachments") ?? []) {
          const wa = wireOf(a);
          if (wa?.type === "image" && (wa.content || wa.data)) {
            const data = wireStr(wa, "content") ?? wireStr(wa, "data") ?? "";
            images.push(`data:${wireStr(wa, "mimeType") ?? "image/png"};base64,${data}`);
          }
        }
        if (text || images.length) {
          items.push({
            kind: "user",
            key: msgKey("u", m, messageIndex),
            text,
            entryId: wireStr(wm, "entryId"),
            imageCount: images.length || undefined,
            images: images.length ? images : undefined,
          });
        }
        break;
      }
      case "assistant": {
        const blocks: Block[] = [];
        const tools: Array<Extract<ChatItem, { kind: "tool" }>> = [];
        for (const b of wireArr(wm, "content") ?? []) {
          const wb = wireOf(b);
          const type = wb?.type;
          const text = wireStr(wb, "text");
          const thinking = wireStr(wb, "thinking");
          if (type === "text" && text?.trim()) {
            blocks.push({ type: "text", text });
          } else if (type === "thinking" && thinking?.trim()) {
            blocks.push({ type: "thinking", text: thinking });
          } else if (type === "toolCall") {
            let args: unknown = wb?.arguments;
            if (typeof args === "string") {
              try {
                args = JSON.parse(args);
              } catch {
                /* keep raw */
              }
            }
            const callId = wireStr(wb, "id") ?? "";
            const t: Extract<ChatItem, { kind: "tool" }> = {
              kind: "tool",
              key: `t-${callId}`,
              toolCallId: callId,
              name: wireStr(wb, "name") ?? "tool",
              args,
              status: "pending",
            };
            tools.push(t);
            toolById.set(callId, t);
          }
        }
        if (blocks.length) {
          const handle = pendingRoomHandle;
          pendingRoomHandle = null;
          const first = blocks[0];
          const replyText = blocks.length === 1 && first?.type === "text" ? first.text : null;
          const passed = handle && tools.length === 0 && replyText != null && isPassReply(replyText);
          if (!passed) {
            items.push({
              kind: "assistant",
              key: msgKey("a", m, messageIndex),
              blocks,
              model: wireStr(wm, "model"),
              ...(handle ? { speaker: handle } : {}),
            });
          }
        } else {
          pendingRoomHandle = null;
          // Failed turns persist as assistant messages with stopReason
          // "error" and no content blocks: without this they rebuild to
          // zero rows and the failure vanishes from history on reload.
          const errText = wireStr(wm, "errorMessage")?.trim();
          if (wm?.stopReason === "error" && errText) {
            items.push({
              kind: "assistant",
              key: msgKey("a", m, messageIndex),
              blocks: [{ type: "text", text: errText }],
              model: wireStr(wm, "model"),
            });
          }
        }
        items.push(...tools);
        break;
      }
      case "toolResult": {
        const callId = wireStr(wm, "toolCallId") ?? "";
        const t = toolById.get(callId);
        if (t) {
          t.status = wm?.isError ? "error" : "done";
          t.output = textOf(wm?.content);
          t.truncated = wm?.truncated === true ? true : undefined;
        } else {
          items.push({
            kind: "tool",
            key: `t-${callId}`,
            toolCallId: callId,
            name: wireStr(wm, "toolName") ?? "tool",
            status: wm?.isError ? "error" : "done",
            output: textOf(wm?.content),
            truncated: wm?.truncated === true ? true : undefined,
          });
        }
        break;
      }
      case "bashExecution": {
        items.push({
          kind: "tool",
          key: msgKey("b", m, messageIndex),
          toolCallId: msgKey("bx", m, messageIndex),
          name: "bash",
          args: { command: wireStr(wm, "command") },
          status: wm?.exitCode ? "error" : "done",
          output: wireStr(wm, "output"),
        });
        break;
      }
      case "custom": {
        if (wm?.display && wm.customType === "babylon_recap") {
          const at = wireNum(wm, "timestamp");
          items.push({ kind: "recap", key: msgKey("c", m, messageIndex), text: textOf(wm?.content), at: at ?? 0 });
        } else if (wm?.customType === "babylon_subagent_activity" || wm?.customType === "babylon_thread_activity" || wm?.customType === "babylon_bot_message") {
          // Matched by type, not display: new writes are display:false (CLI-invisible)
          // while legacy files carry display:true. Recap above stays display-gated.
          items.push({ kind: "system", key: msgKey("c", m, messageIndex), text: textOf(wm?.content) });
        }
        break;
      }
    }
  }
  return items;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return { ...initialState, toasts: state.toasts };
    case "rebuild": {
      const fromMessages = messagesToItems(action.messages);
      // Launch and compaction cards are not part of the agent's session file; preserve any
      // live rows so the user doesn't lose sight of running work after a
      // session-rebuild (e.g. settings change, agent_settled replay).
      const preserved = state.items.filter(
        (it) => (it.kind === "launch" || it.kind === "compaction") && !fromMessages.some((row) => row.key === it.key)
      );
      return {
        ...state,
        items: reconcileItems(state.items, [...fromMessages, ...preserved]),
        streaming: state.streaming,
        steering: state.steering,
        followUp: state.followUp,
        roomTurn: null,
      };
    }
    case "local-user":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "user",
            key: nextKey("u"),
            text: action.text,
            imageCount: action.images?.length || undefined,
            images: action.images?.length ? action.images : undefined,
            optimistic: true,
          },
        ],
      };
    case "local-user-rollback": {
      const idx = state.items.findLastIndex((it) => it.kind === "user" && it.optimistic && it.text === action.text);
      if (idx < 0) return state;
      const items = state.items.slice();
      items.splice(idx, 1);
      return { ...state, items };
    }
    case "notice":
      return {
        ...state,
        items: [...state.items, { kind: "system", key: nextKey("s"), text: action.text }],
      };
    case "dialog-dismiss":
      return { ...state, dialogs: state.dialogs.filter((d) => d.id !== action.id) };
    case "toast": {
      const t: Toast = { ...action.toast, id: ++toastSeq };
      return { ...state, toasts: [...state.toasts.slice(-4), t] };
    }
    case "toast-dismiss":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case "event":
      return applyEvent(state, action.event);
  }
}

/** m:ss elapsed label for run timers and stop records ("0:07", "1:05"). */
export function formatRunDuration(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
}

function applyEvent(state: State, ev: AgentEvent): State {
  // Runtime guard: the wire can still hand us null despite the contract.
  if (!ev || typeof ev !== "object") return state;
  switch (ev.type) {
    case "agent_start":
      return { ...state, streaming: true, streamStartAt: Date.now() };

    case "agent_settled": {
      const items = state.items.slice();
      let needsAbortedNotice = false;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it === undefined) continue;
        if (it.kind === "assistant" && it.streaming) {
          items[i] = { ...it, streaming: false };
          needsAbortedNotice = true;
          break;
        }
        if (it.kind === "assistant" || it.kind === "user") break;
      }
      let next: State = { ...state, items, streaming: false, streamStartAt: null, settledNonce: state.settledNonce + 1, roomTurn: null };
      if (needsAbortedNotice && ev.aborted) {
        next = withToast(next, "warning", "Chat aborted");
        const startedAt = state.streamStartAt;
        const text =
          typeof startedAt === "number" && startedAt > 0
            ? `Chat aborted after ${formatRunDuration(Date.now() - startedAt)}, no response completed.`
            : "Chat aborted, no response completed.";
        next.items = [...next.items, { kind: "system", key: nextKey("s"), text }];
      }
      return next;
    }

    case "babylon_recap": {
      const recap = wireOf(ev.recap);
      const text = wireStr(recap, "text");
      if (!text) return state;
      return {
        ...state,
        items: [...state.items, { kind: "recap", key: nextKey("c"), text, at: Date.parse(wireStr(recap, "at") ?? "") || Date.now() }],
      };
    }

    case "babylon_launch_started": {
      const runId = wireStr(ev, "runId");
      const rawKind = wireStr(ev, "runKind");
      const label = wireStr(ev, "label");
      const runKind: "subagent" | "thread" | "workflow" | undefined =
        rawKind === "subagent" || rawKind === "thread" || rawKind === "workflow" ? rawKind : undefined;
      if (!runId || !runKind) return state;
      const items = state.items.slice();
      // Reuse the row on re-emit (e.g. session rehydrate) so the same key sticks.
      const existing = items.findIndex((it) => it.kind === "launch" && it.runId === runId);
      const next = { kind: "launch" as const, key: `l:${runKind}:${runId}`, runKind, runId, label: label ?? runId, status: "running" as const };
      if (existing >= 0) items[existing] = { ...items[existing], ...next };
      else items.push(next);
      return { ...state, items };
    }

    case "babylon_launch_terminated": {
      const runId = wireStr(ev, "runId");
      const status = wireStr(ev, "status");
      if (!runId) return state;
      const items = state.items.slice();
      const idx = items.findIndex((it) => it.kind === "launch" && it.runId === runId);
      if (idx < 0) return state;
      const current = items[idx];
      if (!current || current.kind !== "launch") return state;
      const next = status === "completed" || status === "failed" || status === "stopped" ? status : "completed";
      items[idx] = { ...current, status: next };
      return { ...state, items };
    }

    case "babylon_launch_update": {
      const runId = wireStr(ev, "runId");
      const status = wireStr(ev, "status");
      const log = wireStr(ev, "log");
      if (!runId) return state;
      const items = state.items.slice();
      const idx = items.findIndex((it) => it.kind === "launch" && it.runId === runId);
      if (idx < 0) return state;
      const current = items[idx];
      if (!current || current.kind !== "launch") return state;
      // Only a terminal status overrides; progress events just refresh the log.
      const nextStatus = status != null && (status === "completed" || status === "failed" || status === "stopped") ? status : current.status;
      items[idx] = { ...current, status: nextStatus, log: log ?? current.log };
      return { ...state, items };
    }

    case "babylon_room_turn": {
      // Group-room presence ("@x is thinking…"). Live-only: replied, passed,
      // stopped, and settled all clear it; rebuilds clear it too.
      const phase = wireStr(ev, "phase");
      const handle = wireStr(ev, "handle") ?? "";
      if (phase === "started" && handle) {
        return { ...state, roomTurn: { handle, phase: "started" } };
      }
      if (!state.roomTurn) return state;
      return { ...state, roomTurn: null };
    }

    case "pideck_history_changed":
      return { ...state, settledNonce: state.settledNonce + 1 };

    case "message_start": {
      const m = wireOf(ev.message);
      if (m?.role === "assistant") {
        return {
          ...state,
          items: [
            ...state.items,
            { kind: "assistant", key: nextKey("a"), blocks: [], model: wireStr(m, "model"), streaming: true },
          ],
        };
      }
      if (m?.role === "custom" && (m.customType === "babylon_subagent_activity" || m.customType === "babylon_thread_activity")) {
        // These activity pings are surfaced on the launch card via
        // babylon_launch_update (single surface, no duplicate chat line).
        return state;
      }
      if (m?.role === "custom" && m.customType === "babylon_bot_message") {
        // Bot-to-bot relay lines have no launch card, render them live.
        const text = textOf(m.content).trim();
        if (text) {
          return {
            ...state,
            items: [...state.items, { kind: "system", key: nextKey("s"), text }],
          };
        }
        return state;
      }
      if (m?.role === "user") {
        const text = textOf(m.content).trim();
        // Room director prompts never render as user bubbles (the rebuild
        // path collapses them the same way).
        if (text && parseRoomTurn(text)) return state;
        if (text) {
          const last = state.items[state.items.length - 1];
          // The composer adds an optimistic row; the authoritative message_start
          // for the same prompt must not render a duplicate copy.
          if (last?.kind === "user" && last.text === text && last.optimistic) {
            const authoritative = messagesToItems([m])[0];
            if (authoritative?.kind === "user" && authoritative.images?.length && !last.images?.length) {
              const items = state.items.slice();
              items[items.length - 1] = { ...last, images: authoritative.images, imageCount: authoritative.images.length };
              return { ...state, items };
            }
            return state;
          }
          return {
            ...state,
            items: [...state.items, { kind: "user", key: nextKey("u"), text }],
          };
        }
      }
      return state;
    }

    case "message_update": {
      const e = wireOf(ev.assistantMessageEvent);
      if (!e) return state;
      const items = state.items.slice();
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it === undefined || it.kind !== "assistant" || !it.streaming) continue;
        const blocks = it.blocks.slice();
        const idx = wireNum(e, "contentIndex") ?? blocks.length;
        const type = wireStr(e, "type");
        if (type === "text_start") {
          blocks[idx] = { type: "text", text: "" };
        } else if (type === "thinking_start") {
          blocks[idx] = { type: "thinking", text: "" };
        } else if (type === "text_delta" || type === "thinking_delta") {
          const cur = blocks[idx] ?? {
            type: type === "text_delta" ? "text" : "thinking",
            text: "",
          };
          blocks[idx] = { ...cur, text: cur.text + (wireStr(e, "delta") ?? "") };
        } else {
          return state;
        }
        items[i] = { ...it, blocks };
        return { ...state, items };
      }
      return state;
    }

    case "message_end": {
      const message = wireOf(ev.message);
      if (message?.role !== "assistant") return state;
      // Authoritative final content. In non-streaming mode message_update was
      // suppressed, so this is what renders the completed reply; in streaming
      // mode it is a faithful re-statement of the accumulated blocks.
      const finalBlocks: Block[] = [];
      for (const b of wireArr(message, "content") ?? []) {
        const wb = wireOf(b);
        const text = wireStr(wb, "text");
        const thinking = wireStr(wb, "thinking");
        if (wb?.type === "text" && text?.trim()) finalBlocks.push({ type: "text", text });
        else if (wb?.type === "thinking" && thinking?.trim()) finalBlocks.push({ type: "thinking", text: thinking });
      }
      const items = state.items.slice();
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it === undefined) continue;
        if (it.kind === "assistant" && it.streaming) {
          items[i] = { ...it, blocks: finalBlocks.length ? finalBlocks : it.blocks, streaming: false };
          return { ...state, items };
        }
      }
      return state;
    }

    case "tool_execution_start": {
      const items = state.items.slice();
      const toolCallId = wireStr(ev, "toolCallId") ?? "";
      const at = items.findIndex(
        (it) => it.kind === "tool" && it.toolCallId === toolCallId
      );
      const base = at >= 0 ? (items[at] as Extract<ChatItem, { kind: "tool" }>) : undefined;
      const item: Extract<ChatItem, { kind: "tool" }> = {
        kind: "tool",
        key: base?.key ?? nextKey("t"),
        toolCallId,
        name: wireStr(ev, "toolName") ?? "tool",
        args: ev.args,
        status: "running",
        output: base?.output,
        babylon: base?.babylon,
      };
      if (at >= 0) items[at] = item;
      else items.push(item);
      return { ...state, items };
    }

    case "tool_execution_update":
      // partialResult.content is accumulated output so far: replace.
      return mapTool(state, wireStr(ev, "toolCallId") ?? "", (t) => ({
        ...t,
        output: textOf(fieldOf(ev.partialResult, "content")),
        babylon: babylonMeta(fieldOf(fieldOf(ev.partialResult, "details"), "babylon")) ?? t.babylon,
      }));

    case "tool_execution_end":
      return mapTool(state, wireStr(ev, "toolCallId") ?? "", (t) => {
        const result = wireOf(ev.result);
        return {
          ...t,
          status: ev.isError ? "error" : "done",
          output: textOf(result?.content),
          details: wireOf(result?.details),
          babylon: babylonMeta(fieldOf(wireOf(result?.details), "babylon")) ?? t.babylon,
        };
      });

    case "queue_update":
      return { ...state, steering: wireStrArr(ev, "steering") ?? [], followUp: wireStrArr(ev, "followUp") ?? [] };

    case "extension_ui_cancel":
      return { ...state, dialogs: state.dialogs.filter((dialog) => dialog.id !== wireStr(ev, "id")) };

    case "extension_ui_request": {
      const method = wireStr(ev, "method");
      if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
        return {
          ...state,
          dialogs: [
            ...state.dialogs,
            {
              id: wireStr(ev, "id") ?? "",
              method,
              title: wireStr(ev, "title"),
              message: wireStr(ev, "message"),
              options: wireStrArr(ev, "options"),
              placeholder: wireStr(ev, "placeholder"),
              prefill: wireStr(ev, "prefill"),
            },
          ],
        };
      }
      if (method === "notify" && wireStr(ev, "message")) {
        const notifyType = wireStr(ev, "notifyType");
        return withToast(state, notifyType === "error" || notifyType === "warning" ? notifyType : "info", wireStr(ev, "message") ?? "");
      }
      return state;
    }

    case "compaction_start": {
      const compactionItem: Extract<ChatItem, { kind: "compaction" }> = {
        kind: "compaction",
        key: nextKey("compaction"),
        status: "compacting",
        reason: wireStr(ev, "reason") ?? "auto",
      };
      return {
        ...withToast(state, "info", "Compacting context…"),
        items: [...state.items, compactionItem],
      };
    }

    case "compaction_end": {
      const items = state.items.slice();
      let idx = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it !== undefined && it.kind === "compaction" && it.status === "compacting") {
          idx = i;
          break;
        }
      }
      const aborted = !!ev.aborted;
      const errorMessage = wireStr(ev, "errorMessage");
      const result = wireOf(ev.result);
      const compacted = result
        ? { tokensBefore: wireNum(result, "tokensBefore"), estimatedTokensAfter: wireNum(result, "estimatedTokensAfter") }
        : undefined;
      let nextState: State = state;
      if (idx >= 0) {
        const cur = items[idx] as Extract<ChatItem, { kind: "compaction" }>;
        if (aborted) {
          items[idx] = { ...cur, status: "aborted" as const };
        } else if (errorMessage) {
          items[idx] = { ...cur, status: "failed" as const, error: errorMessage };
        } else {
          items[idx] = { ...cur, status: "compacted" as const, result: compacted };
        }
        nextState = { ...state, items };
      } else {
        const status = aborted ? ("aborted" as const) : errorMessage ? ("failed" as const) : ("compacted" as const);
        const compactionItem: Extract<ChatItem, { kind: "compaction" }> = {
          kind: "compaction",
          key: nextKey("compaction"),
          status,
          reason: wireStr(ev, "reason") ?? "auto",
          result: compacted,
          error: errorMessage,
        };
        nextState = { ...state, items: [...state.items, compactionItem] };
      }
      if (aborted) return withToast(nextState, "warning", "Compaction aborted");
      if (errorMessage) return withToast(nextState, "error", `Compaction failed: ${errorMessage}`);
      return withToast(
        nextState,
        "info",
        compacted ? `Context compacted: ${fmtTokens(compacted.tokensBefore)} → ~${fmtTokens(compacted.estimatedTokensAfter)} tokens` : "Context compacted"
      );
    }

    case "babylon_handoff_consumed": {
      // A handoff summary was installed as a compaction boundary in the live
      // chat. Renders with the CompactionCard vocabulary (context boundary,
      // not a message) and survives rebuilds like any settled compaction row.
      const sourceName = wireStr(ev, "sourceName") || "history";
      const item: Extract<ChatItem, { kind: "compaction" }> = {
        kind: "compaction",
        key: nextKey("compaction"),
        status: "compacted",
        reason: `handoff from ${sourceName}`,
        result: {
          tokensBefore: wireNum(ev, "tokensBefore"),
          estimatedTokensAfter: wireNum(ev, "estimatedTokensAfter"),
        },
      };
      return withToast(
        { ...state, items: [...state.items, item] },
        "info",
        `Handoff from ${sourceName} installed`
      );
    }

    case "auto_retry_start": {
      const attempt = fieldOf(ev, "attempt");
      return withToast(state, "warning", `Retrying after transient error (attempt ${typeof attempt === "number" ? attempt : "?"})…`);
    }

    case "auto_retry_end": {
      // Retries exhausted (or recovered): success clears silently, failure
      // must not drop — the retry warning above auto-dismisses, so without
      // this the user watches the spinner stop with no explanation.
      if (wireOf(ev)?.success !== false) return state;
      const err = wireStr(wireOf(ev), "finalError")?.trim();
      const text = err ? `Chat failed: ${err}` : "Chat failed.";
      const next = withToast(state, "error", text);
      next.items = [...next.items, { kind: "system", key: nextKey("s"), text }];
      return next;
    }

    case "extension_error":
      return withToast(state, "error", `Extension error: ${String(fieldOf(ev, "error") ?? "unknown")}`);

    default:
      return state;
  }
}

function withToast(state: State, type: Toast["type"], text: string): State {
  return reducer(state, { type: "toast", toast: { type, text } });
}

function mapTool(
  state: State,
  toolCallId: string,
  fn: (t: Extract<ChatItem, { kind: "tool" }>) => Extract<ChatItem, { kind: "tool" }>
): State {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item === undefined || item.kind !== "tool" || item.toolCallId !== toolCallId) continue;
    const items = state.items.slice();
    items[i] = fn(item);
    return { ...state, items };
  }
  return state;
}

/** Reuse unchanged rows after authoritative hydration so memoized chat content stays mounted. */
export function reconcileItems(previous: ChatItem[], next: ChatItem[]): ChatItem[] {
  const byKey = new Map(previous.map((item) => [item.key, item]));
  return next.map((item) => {
    const old = byKey.get(item.key);
    return old && sameItem(old, item) ? old : item;
  });
}

function sameItem(a: ChatItem, b: ChatItem): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === "user" && b.kind === "user") {
    if (a.text !== b.text || (a.images?.length ?? 0) !== (b.images?.length ?? 0)) return false;
    return (a.images ?? []).every((image, index) => image === b.images?.[index]);
  }
  if (a.kind === "assistant" && b.kind === "assistant") {
    return (
      a.model === b.model &&
      a.speaker === b.speaker &&
      !!a.streaming === !!b.streaming &&
      a.blocks.length === b.blocks.length &&
      a.blocks.every((block, index) => {
        const other = b.blocks[index];
        return block.type === other?.type && block.text === other.text;
      })
    );
  }
  if (a.kind === "tool" && b.kind === "tool") {
    return (
      a.toolCallId === b.toolCallId &&
      a.name === b.name &&
      a.status === b.status &&
      a.output === b.output &&
      a.truncated === b.truncated &&
      cheapSig(a.args) === cheapSig(b.args) &&
      cheapSig(a.details) === cheapSig(b.details)
    );
  }
  if (a.kind === "system" && b.kind === "system") return a.text === b.text;
  if (a.kind === "recap" && b.kind === "recap") return a.text === b.text && a.at === b.at;
  if (a.kind === "launch" && b.kind === "launch") {
    return a.runId === b.runId && a.status === b.status && a.label === b.label && a.log === b.log;
  }
  if (a.kind === "compaction" && b.kind === "compaction") {
    return a.status === b.status && a.reason === b.reason && a.error === b.error && cheapSig(a.result) === cheapSig(b.result);
  }
  return false;
}

/** Structural signature for tool args/details. Every string byte contributes so
 *  middle-only changes cannot leave a stale memoized tool row. */
function cheapSig(value: unknown): string {
  if (value == null) return "n";
  if (typeof value === "string") {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
    return `s${value.length}:${hash}`;
  }
  if (typeof value === "number") return `n${value}`;
  if (typeof value === "boolean") return `b${value}`;
  if (Array.isArray(value)) return `a[${value.length}:${value.map(cheapSig).join("|")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `o{${keys.length}:${keys.map((key) => `${key}=${cheapSig(fieldOf(value, key))}`).join(";")}}`;
  }
  return "?";
}

import { formatTokens } from "./lib/format";
export const fmtTokens = formatTokens;
