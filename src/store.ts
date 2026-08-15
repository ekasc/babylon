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

export type ChatItem =
  | { kind: "user"; key: string; text: string; entryId?: string; imageCount?: number; images?: string[]; optimistic?: boolean }
  | {
      kind: "assistant";
      key: string;
      blocks: Block[];
      model?: string;
      streaming?: boolean;
    }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
      name: string;
      args?: any;
      status: ToolStatus;
      output?: string;
      details?: any;
      /** Output was clamped at the wire; a "show full" fetch is available. */
      truncated?: boolean;
    }
  | { kind: "system"; key: string; text: string }
  | { kind: "recap"; key: string; text: string; at: number };

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

export interface State {
  items: ChatItem[];
  streaming: boolean;
  steering: string[];
  followUp: string[];
  dialogs: Dialog[];
  toasts: Toast[];
  settledNonce: number;
}

export type Action =
  | { type: "reset" }
  | { type: "rebuild"; messages: any[] }
  | { type: "event"; event: any }
  | { type: "local-user"; text: string; images?: string[] }
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
function msgKey(role: string, m: any, index: number): string {
  const ts = m?.timestamp ?? index;
  return `${role}:${ts}:${index}`;
}
let toastSeq = 0;

export const initialState: State = {
  items: [],
  streaming: false,
  steering: [],
  followUp: [],
  dialogs: [],
  toasts: [],
  settledNonce: 0,
};

export function textOf(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === "string" ? c : (c?.text ?? "")))
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
export function mergeLiveMessages(loaded: any[], live: any[]): any[] {
  const last = loaded.length ? loaded[loaded.length - 1] : null;
  const lastTs = typeof last?.timestamp === "number" ? last.timestamp : 0;
  const fresh: any[] = [];
  for (const message of live ?? []) {
    if (typeof message?.timestamp === "number" && message.timestamp > lastTs) fresh.push(message);
  }
  return fresh.length ? [...loaded, ...fresh] : loaded;
}

export function messagesToItems(messages: any[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolById = new Map<string, Extract<ChatItem, { kind: "tool" }>>();

  for (let messageIndex = 0; messageIndex < (messages?.length ?? 0); messageIndex++) {
    const m = messages[messageIndex];
    switch (m?.role) {
      case "user": {
        const text = textOf(m.content).trim();
        const images: string[] = [];
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type === "image") {
              const data = b.data ?? b.source?.data;
              const mime = b.mimeType ?? b.source?.mediaType ?? "image/png";
              if (data) images.push(`data:${mime};base64,${data}`);
            }
          }
        }
        for (const a of m.attachments ?? []) {
          if (a?.type === "image" && (a.content || a.data)) {
            images.push(`data:${a.mimeType ?? "image/png"};base64,${a.content ?? a.data}`);
          }
        }
        if (text || images.length) {
          items.push({
            kind: "user",
            key: msgKey("u", m, messageIndex),
            text,
            entryId: typeof m.entryId === "string" ? m.entryId : undefined,
            imageCount: images.length || undefined,
            images: images.length ? images : undefined,
          });
        }
        break;
      }
      case "assistant": {
        const blocks: Block[] = [];
        const tools: Array<Extract<ChatItem, { kind: "tool" }>> = [];
        for (const b of m.content ?? []) {
          if (b?.type === "text" && b.text?.trim()) {
            blocks.push({ type: "text", text: b.text });
          } else if (b?.type === "thinking" && b.thinking?.trim()) {
            blocks.push({ type: "thinking", text: b.thinking });
          } else if (b?.type === "toolCall") {
            let args = b.arguments;
            if (typeof args === "string") {
              try {
                args = JSON.parse(args);
              } catch {
                /* keep raw */
              }
            }
            const t: Extract<ChatItem, { kind: "tool" }> = {
              kind: "tool",
              key: `t-${b.id}`,
              toolCallId: b.id,
              name: b.name,
              args,
              status: "pending",
            };
            tools.push(t);
            toolById.set(b.id, t);
          }
        }
        if (blocks.length) {
          items.push({ kind: "assistant", key: msgKey("a", m, messageIndex), blocks, model: m.model });
        }
        items.push(...tools);
        break;
      }
      case "toolResult": {
        const t = toolById.get(m.toolCallId);
        if (t) {
          t.status = m.isError ? "error" : "done";
          t.output = textOf(m.content);
          t.truncated = m.truncated === true ? true : undefined;
        } else {
          items.push({
            kind: "tool",
            key: `t-${m.toolCallId}`,
            toolCallId: m.toolCallId,
            name: m.toolName ?? "tool",
            status: m.isError ? "error" : "done",
            output: textOf(m.content),
            truncated: m.truncated === true ? true : undefined,
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
          args: { command: m.command },
          status: m.exitCode ? "error" : "done",
          output: m.output,
        });
        break;
      }
      case "custom": {
        if (m.display && m.customType === "babylon_recap") {
          items.push({ kind: "recap", key: msgKey("c", m, messageIndex), text: textOf(m.content), at: typeof m.timestamp === "number" ? m.timestamp : 0 });
        } else if (m.display && (m.customType === "babylon_subagent_activity" || m.customType === "babylon_thread_activity")) {
          items.push({ kind: "system", key: msgKey("c", m, messageIndex), text: textOf(m.content) });
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
    case "rebuild":
      return {
        ...state,
        items: reconcileItems(state.items, messagesToItems(action.messages)),
        streaming: false,
        steering: [],
        followUp: [],
      };
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

function applyEvent(state: State, ev: any): State {
  if (!ev || typeof ev !== "object") return state;
  switch (ev.type) {
    case "agent_start":
      return { ...state, streaming: true };

    case "agent_settled":
      return { ...state, streaming: false, settledNonce: state.settledNonce + 1 };

    case "babylon_recap": {
      const text = ev.recap?.text;
      if (!text) return state;
      return {
        ...state,
        items: [...state.items, { kind: "recap", key: nextKey("c"), text, at: Date.parse(ev.recap?.at ?? "") || Date.now() }],
      };
    }

    case "pideck_history_changed":
      return { ...state, settledNonce: state.settledNonce + 1 };

    case "message_start": {
      const m = ev.message;
      if (m?.role === "assistant") {
        return {
          ...state,
          items: [
            ...state.items,
            { kind: "assistant", key: nextKey("a"), blocks: [], model: m.model, streaming: true },
          ],
        };
      }
      if (m?.role === "custom" && m.display && (m.customType === "babylon_subagent_activity" || m.customType === "babylon_thread_activity")) {
        return { ...state, items: [...state.items, { kind: "system", key: nextKey("c"), text: textOf(m.content) }] };
      }
      if (m?.role === "user") {
        const text = textOf(m.content).trim();
        if (text) {
          const last = state.items[state.items.length - 1];
          // The composer adds an optimistic row; the authoritative message_start
          // for the same prompt must not render a duplicate copy.
          if (last?.kind === "user" && last.text === text && last.key.startsWith("u")) {
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
      const e = ev.assistantMessageEvent;
      if (!e) return state;
      const items = state.items.slice();
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind !== "assistant" || !it.streaming) continue;
        const blocks = it.blocks.slice();
        const idx = typeof e.contentIndex === "number" ? e.contentIndex : blocks.length;
        if (e.type === "text_start") {
          blocks[idx] = { type: "text", text: "" };
        } else if (e.type === "thinking_start") {
          blocks[idx] = { type: "thinking", text: "" };
        } else if (e.type === "text_delta" || e.type === "thinking_delta") {
          const cur = blocks[idx] ?? {
            type: e.type === "text_delta" ? "text" : "thinking",
            text: "",
          };
          blocks[idx] = { ...cur, text: cur.text + (e.delta ?? "") };
        } else {
          return state;
        }
        items[i] = { ...it, blocks };
        return { ...state, items };
      }
      return state;
    }

    case "message_end": {
      if (ev.message?.role !== "assistant") return state;
      const items = state.items.slice();
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "assistant" && it.streaming) {
          items[i] = { ...it, streaming: false };
          return { ...state, items };
        }
      }
      return state;
    }

    case "tool_execution_start": {
      const items = state.items.slice();
      const at = items.findIndex(
        (it) => it.kind === "tool" && it.toolCallId === ev.toolCallId
      );
      const base = at >= 0 ? (items[at] as Extract<ChatItem, { kind: "tool" }>) : undefined;
      const item: Extract<ChatItem, { kind: "tool" }> = {
        kind: "tool",
        key: base?.key ?? nextKey("t"),
        toolCallId: ev.toolCallId,
        name: ev.toolName,
        args: ev.args,
        status: "running",
        output: base?.output,
      };
      if (at >= 0) items[at] = item;
      else items.push(item);
      return { ...state, items };
    }

    case "tool_execution_update":
      // partialResult.content is accumulated output so far: replace.
      return mapTool(state, ev.toolCallId, (t) => ({
        ...t,
        output: textOf(ev.partialResult?.content),
      }));

    case "tool_execution_end":
      return mapTool(state, ev.toolCallId, (t) => ({
        ...t,
        status: ev.isError ? "error" : "done",
        output: textOf(ev.result?.content),
        details: ev.result?.details,
      }));

    case "queue_update":
      return { ...state, steering: ev.steering ?? [], followUp: ev.followUp ?? [] };

    case "extension_ui_cancel":
      return { ...state, dialogs: state.dialogs.filter((dialog) => dialog.id !== ev.id) };

    case "extension_ui_request": {
      if (["select", "confirm", "input", "editor"].includes(ev.method)) {
        return {
          ...state,
          dialogs: [
            ...state.dialogs,
            {
              id: ev.id,
              method: ev.method,
              title: ev.title,
              message: ev.message,
              options: ev.options,
              placeholder: ev.placeholder,
              prefill: ev.prefill,
            },
          ],
        };
      }
      if (ev.method === "notify" && ev.message) {
        return withToast(state, ev.notifyType ?? "info", ev.message);
      }
      return state;
    }

    case "compaction_start":
      return withToast(state, "info", "Compacting context…");

    case "compaction_end": {
      if (ev.aborted) return withToast(state, "warning", "Compaction aborted");
      if (ev.errorMessage) return withToast(state, "error", `Compaction failed: ${ev.errorMessage}`);
      const r = ev.result;
      return withToast(
        state,
        "info",
        r
          ? `Context compacted: ${fmtTokens(r.tokensBefore)} → ~${fmtTokens(r.estimatedTokensAfter)} tokens`
          : "Context compacted"
      );
    }

    case "auto_retry_start":
      return withToast(state, "warning", `Retrying after transient error (attempt ${ev.attempt})…`);

    case "extension_error":
      return withToast(state, "error", `Extension error: ${ev.error}`);

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
    if (item.kind !== "tool" || item.toolCallId !== toolCallId) continue;
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
  return false;
}

/** O(keys) structural signature for tool args/details. Large strings are
 *  compared by length + head/tail instead of byte-for-byte; any change flips
 *  the signature, which is all sameItem needs (rebuilds stop comparing
 *  megabytes of patch/diff text). */
function cheapSig(value: any): string {
  if (value == null) return "n";
  if (typeof value === "string") {
    return value.length > 128 ? `s${value.length}:${value.slice(0, 32)}:${value.slice(-32)}` : `s${value.length}:${value}`;
  }
  if (typeof value === "number") return `n${value}`;
  if (typeof value === "boolean") return `b${value}`;
  if (Array.isArray(value)) return `a[${value.length}:${value.map(cheapSig).join("|")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `o{${keys.length}:${keys.map((key) => `${key}=${cheapSig(value[key])}`).join(";")}}`;
  }
  return "?";
}

export function fmtTokens(n?: number): string {
  if (n == null) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
