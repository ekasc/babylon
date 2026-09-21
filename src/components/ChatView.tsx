import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatItem } from "../store";
import { buildTurnFolds } from "../lib/chat-folds";
import { isContinuousScroll, isScrollKey, shouldBreakFollow } from "../lib/scroll-follow";
import type { HistoryTurn } from "../bridge";
import type { Bot } from "../bots";
import { botHandle } from "../bots";
import { UserMessage, AssistantMessage, ToolCard, ToolGroup, SystemLine, RecapLine, LaunchCard } from "./items";
import { ArrowDownIcon } from "./icons";
import { BotAvatar } from "./BotAvatar";
import { formatTokens } from "../lib/format";

/** Group-room speaker header: avatar + name so member turns read as voices. */
export function MemberHeader({ handle, members }: { handle: string; members: Bot[] }) {
  const member = members.find((m) => botHandle(m) === handle);
  return (
    <div className="mb-1 flex min-w-0 items-center gap-1.5" data-room-speaker={handle}>
      <BotAvatar name={member?.name ?? handle} size={16} />
      <span className="truncate text-[12px] font-semibold">{member?.name ?? `@${handle}`}</span>
      {member?.title ? <span className="truncate text-[11px] text-dim">{member.title}</span> : null}
    </div>
  );
}

/** Group-room host header: the facilitator's own replies (answers to you
 *  directly, not member turns) get the room's identity, never a blank bubble. */
export function RoomHostHeader({ roomName }: { roomName: string }) {
  return (
    <div className="mb-1 flex min-w-0 items-center gap-1.5" data-room-host={roomName}>
      <BotAvatar name={roomName} size={16} />
      <span className="truncate text-[12px] font-semibold">{roomName}</span>
      <span className="truncate text-[11px] text-dim">host</span>
    </div>
  );
}

/** Speaker attribution above an assistant turn: the directed member when known,
 *  the room host for unattributed room replies, nothing in plain chats. Shared
 *  project chats show member headers without the host fallback (the default bot
 *  is the implicit speaker) and keep thinking visible. */
function SpeakerHead({ speaker, streaming, roomHandle, members, isRoom, roomName, showSpeakers }: {
  speaker?: string; streaming?: boolean; roomHandle?: string | null; members: Bot[]; isRoom: boolean; roomName: string; showSpeakers: boolean;
}) {
  if (!isRoom && !showSpeakers) return null;
  const handle = speaker ?? (streaming ? roomHandle : null);
  if (handle) return <MemberHeader handle={handle} members={members} />;
  if (isRoom) return <RoomHostHeader roomName={roomName} />;
  return null;
}

const CompactionCard = memo(function CompactionCard({ item }: { item: Extract<ChatItem, { kind: "compaction" }> }) {
  const isCompacting = item.status === "compacting";
  const isFailed = item.status === "failed";
  const isAborted = item.status === "aborted";
  // Status dot matches the tool/launch register (no text glyphs).
  const dotClass = isFailed ? "bg-err" : isAborted ? "bg-warn" : "bg-ok";
  let text: string;
  let subtext: string | null = null;
  if (isCompacting) {
    text = "Compacting…";
    subtext = item.reason ? `${item.reason}` : null;
  } else if (isAborted) {
    text = "Compaction aborted";
  } else if (isFailed) {
    text = "Compaction failed";
    subtext = item.error ?? null;
  } else {
    const r = item.result;
    if (r?.tokensBefore != null && r?.estimatedTokensAfter != null) {
      text = `${formatTokens(r.tokensBefore)}→${formatTokens(r.estimatedTokensAfter)}`;
    } else {
      text = "Compacted";
    }
    subtext = item.reason && item.reason !== "auto" ? item.reason : null;
  }
  return (
    <div
      className={`my-3 flex w-fit items-center gap-2.5 rounded-md border px-3 py-1.5 text-[11px] ${isFailed ? "border-err/30 bg-err/10 text-err" : isAborted ? "border-warn/30 bg-warn/10 text-warn" : "border-line bg-inset/60 text-dim"}`}
      style={{ maxWidth: "100%" }}
      role="status"
      aria-live="polite"
    >
      {isCompacting ? <span className="spinner inline-block h-3 w-3 shrink-0 rounded-full border-[1.5px] border-line border-t-accent animate-spin" aria-hidden /> : <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />}
      <span className="font-medium tabular-nums tracking-tight" style={{ color: isFailed || isAborted ? undefined : "var(--fg)" }}>{text}</span>
      {subtext ? <span className="text-dim truncate">· {subtext}</span> : null}
    </div>
  );
});
import { TurnChanges } from "./TurnChanges";

/** Runs of consecutive tool calls at least this long render as one collapsed row. */
const TOOL_GROUP_MIN = 4;

type Entry =
  | { type: "single"; item: ChatItem; index: number }
  | { type: "group"; tools: Array<Extract<ChatItem, { kind: "tool" }>>; index: number };

function buildEntries(shown: ChatItem[]): Entry[] {
  const entries: Entry[] = [];
  for (let i = 0; i < shown.length; ) {
    const cur = shown[i];
    if (cur === undefined) {
      i++;
      continue;
    }
    if (cur.kind !== "tool") {
      entries.push({ type: "single", item: cur, index: i });
      i++;
      continue;
    }
    let j = i;
    while (j < shown.length) {
      const nxt = shown[j];
      if (nxt === undefined || nxt.kind !== "tool") break;
      j++;
    }
    const run: Array<Extract<ChatItem, { kind: "tool" }>> = [];
    for (let k = i; k < j; k++) {
      const t = shown[k];
      if (t !== undefined && t.kind === "tool") run.push(t);
    }
    if (run.length >= TOOL_GROUP_MIN) {
      entries.push({ type: "group", tools: run, index: j - 1 });
    } else {
      for (let k = i; k < j; k++) {
        const t = shown[k];
        if (t !== undefined) entries.push({ type: "single", item: t, index: k });
      }
    }
    i = j;
  }
  return entries;
}

/** Markdown blockquote for quote-in-composer. Blank lines stay bare `>`. */
export function formatBlockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/** Max quoted characters (T3 caps citation text the same way). */
export const QUOTE_MAX_CHARS = 2000;

/** One in-transcript find hit: item key for scroll targeting, index for folds. */
export interface TranscriptMatch {
  key: string;
  index: number;
}

/** Case-insensitive substring search over message text (tools excluded —
 *  their rows are command chips, not prose). */
export function findTranscriptMatches(items: ChatItem[], query: string): TranscriptMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: TranscriptMatch[] = [];
  items.forEach((item, index) => {
    let hay = "";
    if (item.kind === "user" || item.kind === "system" || item.kind === "recap") hay = item.text ?? "";
    else if (item.kind === "assistant") hay = item.blocks.map((b) => b.text).join("\n");
    else if (item.kind === "launch") hay = `${item.label ?? ""}\n${item.log ?? ""}`;
    else if (item.kind === "compaction") hay = item.reason ?? "";
    if (hay.toLowerCase().includes(q)) out.push({ key: item.key, index });
  });
  return out;
}

interface Props {
  items: ChatItem[];
  /** True while an older stored-transcript window still exists. */
  canLoadMore?: boolean;
  loadingEarlier?: boolean;
  /** Called when the user scrolls to the top of the loaded region. */
  onNeedEarlier?(): void;
  streaming: boolean;
  /** Stream responses pref: live turns run expanded so the stream is
   *  visible; settled turns fold to just the final message. */
  streamResponses?: boolean;
  historyTurns?: HistoryTurn[];
  onRollback?(entryId: string): void;
  /** Bumped by the App on every send: sending re-engages follow and pins
   *  to the new message deterministically, instead of relying on the
   *  append path's stick/recency gates (which strand the optimistic row
   *  when the user sent from a scrolled-up viewport). */
  pinNonce?: number;
  /** Quote in composer (T3 cite): assistant text selection quoted as a
   *  markdown blockquote into the composer draft. Receives raw text. */
  onQuote?(text: string): void;
  onOpenLaunch?(runId: string, runKind: "subagent" | "thread" | "workflow"): void;
  onControlLaunch?(runId: string, runKind: "subagent" | "thread" | "workflow", action: "stop"): void;
  /** Group room: hide reasoning blocks and director machinery (collapsed in
   *  the store); show member presence instead. */
  isRoom?: boolean;
  /** Live member turn handle while a room turn streams, else null. */
  roomHandle?: string | null;
  /** Room members for speaker headers. */
  roomMembers?: Bot[];
  /** Room name for the host header (facilitator replies carry no speaker). */
  roomName?: string;
  /** Shared project chat with staff: show speaker headers for extra-bot turns
   *  without hiding thinking (rooms hide it; shared chats keep it). */
  showSpeakers?: boolean;
  /** Project display name for the empty-conversation heading. When omitted
   *  the generic heading is used. */
  projectName?: string | null;
}


export default memo(function ChatView({
  items,
  canLoadMore = false,
  loadingEarlier = false,
  onNeedEarlier,
  streaming,
  historyTurns = [],
  onRollback,
  onQuote,
  onOpenLaunch,
  onControlLaunch,
  isRoom = false,
  roomHandle = null,
  roomMembers = [],
  roomName = "",
  showSpeakers = false,
  projectName = null,
  streamResponses = false,
  pinNonce = 0,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Stick-to-bottom ownership: exactly one rule. While `stick` is true the
  // viewport follows content growth (streaming deltas, tool output,
  // reasoning, code blocks); any intentional scroll-up clears it and content
  // growth never moves the viewport again until the user returns to the
  // bottom (or hits Jump to bottom).
  const stick = useRef(true);
  const lastUserScrollAt = useRef(0);
  // Last genuine input gesture (wheel, touch, scroll keys, pointer drag).
  // Only these — never bare scroll events — may break follow, so layout
  // shifts, scroll anchoring, and smooth landings can't strand the viewport.
  const lastInputAt = useRef(0);
  const lastPointerDown = useRef(0);
  const lastScrollSample = useRef({ at: 0, top: 0 });
  const showJumpVisible = useRef(false);
  const [showJump, setShowJump] = useState(false);
  // In-transcript find: Cmd/Ctrl+F opens a floating bar; Enter jumps between
  // matches, expanding collapsed folds on the way.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const itemEls = useRef(new Map<string, HTMLDivElement>());
  const trackItemEl = useCallback(
    (key: string) => (el: HTMLDivElement | null) => {
      if (el) itemEls.current.set(key, el);
      else itemEls.current.delete(key);
    },
    []
  );
  const clearFindFlash = useCallback(() => {
    for (const n of document.querySelectorAll(".find-target-flash")) n.classList.remove("find-target-flash");
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    clearFindFlash();
  }, [clearFindFlash]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f" || e.shiftKey || e.altKey) return;
      const ae = document.activeElement;
      if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || (ae instanceof HTMLElement && ae.isContentEditable)) return;
      e.preventDefault();
      setFindOpen(true);
      setFindIdx(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Quote in composer: selecting assistant transcript text surfaces a
  // floating Quote button (T3's cite toolbar, one action). Assistant-only so
  // user messages and inputs never quote.
  const [quoteSel, setQuoteSel] = useState<{ x: number; y: number; text: string } | null>(null);
  useEffect(() => {
    if (!onQuote) return;
    const update = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setQuoteSel(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = ref.current;
      if (!container || !container.contains(range.commonAncestorContainer)) {
        setQuoteSel(null);
        return;
      }
      const node = range.commonAncestorContainer;
      const el = node instanceof Element ? node : node.parentElement;
      if (!el || !el.closest(".conversation-assistant")) {
        setQuoteSel(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        setQuoteSel(null);
        return;
      }
      // Rect reads can throw in non-visual DOMs (jsdom); fall back to a
      // top-left anchor so quoting still works there.
      let x = 8;
      let y = 6;
      try {
        const rect = range.getBoundingClientRect();
        x = Math.max(8, Math.min(rect.left, window.innerWidth - 120));
        y = Math.min(window.innerHeight - 48, rect.bottom + 6);
      } catch {
        /* keep fallback anchor */
      }
      setQuoteSel({
        x,
        y,
        text: text.length > QUOTE_MAX_CHARS ? text.slice(0, QUOTE_MAX_CHARS) : text,
      });
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [onQuote]);
  const setStick = (next: boolean) => {
    stick.current = next;
    if (showJumpVisible.current === next) {
      showJumpVisible.current = !next;
      setShowJump(!next);
    }
  };
  // Explicit send pin: sending re-engages follow no matter where the
  // viewport was. Skips the first render (nonce starts at 0).
  const lastPinNonce = useRef(pinNonce);
  useEffect(() => {
    if (pinNonce === lastPinNonce.current) return;
    lastPinNonce.current = pinNonce;
    setStick(true);
    lastUserScrollAt.current = 0;
    pinToBottom();
  }, [pinNonce]);
  // Keyboard scrolls are gestures too (the scroller itself is not focusable,
  // so listen on window and ignore fields where keys edit text).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (isScrollKey(e.key)) lastInputAt.current = Date.now();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // Disclosure settle (T3Code's suspendEndScrollMaintenanceForDisclosure): a
  // fold/tool expand or collapse reshapes content above the viewport. The
  // follow observer must ignore the next beat so it never yanks a pinned
  // viewport to the bottom (or drops it) mid-disclosure; live growth resumes
  // following immediately after.
  const followSuspendUntil = useRef(0);
  const suspendFollowForDisclosure = useCallback(() => {
    followSuspendUntil.current = Date.now() + 300;
  }, []);
  // Target of our own most recent programmatic pin (scrollHeight at pin
  // time). A pin's scroll event can land with dist > threshold when content
  // grows between the pin and the event dispatch — that landing must not
  // read as an intentional scroll-up. Matching the event's scrollTop
  // against this target (not against live dist) tells our pins apart.
  const lastPin = useRef<{ target: number; at: number } | null>(null);
  const pinToBottom = () => {
    const el = ref.current;
    if (!el) return;
    lastPin.current = { target: el.scrollHeight - el.clientHeight, at: Date.now() };
    el.scrollTop = el.scrollHeight;
  };
  const prevHeight = useRef(0);
  const prevFirstKey = useRef<string | null>(null);
  const prevLastKey = useRef<string | null>(null);
  const prevLength = useRef(0);


  // The full transcript is always mounted: no suffix windowing, so scroll
  // position and continuity survive streaming, prepends, and rebuilds.
  const shown = items;

  const onScroll = () => {
    setQuoteSel(null);
    const el = ref.current;
    if (!el) return;
    const now = Date.now();
    const pin = lastPin.current;
    if (pin && now - pin.at < 500 && Math.abs(el.scrollTop - pin.target) < 4) {
      // Our own pin landing (possibly already stale by new growth): the user
      // didn't scroll, stay pinned and let the observer follow the growth.
      setStick(true);
    } else {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = dist < 32;
      if (atBottom) {
        setStick(true);
      } else {
        lastUserScrollAt.current = now;
        const gestured = now - lastInputAt.current < 400;
        const continuous = isContinuousScroll(lastScrollSample.current, now, el.scrollTop);
        if (shouldBreakFollow({ gestured, continuous })) setStick(false);
      }
    }
    lastScrollSample.current = { at: now, top: el.scrollTop };
    // Scroll-up streaming: near the top of the loaded region, ask for the next
    // older window. The App guards against duplicate concurrent fetches.
    // Scroll-up streaming: near the top of the loaded region, ask for the next
    // older window. The App guards against duplicate concurrent fetches.
    // onScroll is re-bound every render, so props read here are always
    // current; the old mirror refs were pure cruft.
    if (el.scrollTop < 400 && canLoadMore) {
      onNeedEarlier?.();
    }
  };

  // Pin on first open and on new-chat switch, and on genuine appends at
  // the end when the user is still following. Fold expand / streaming
  // deltas (same item grows) do NOT pin via this path; growth is followed
  // by the ResizeObserver below, gated on the same `stick` flag.
  // `prepended` is only for "load earlier" where the old first item is
  // still visible in the new window: compensate so the viewport stays put.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prevKey = prevFirstKey.current;
    const prevLast = prevLastKey.current;
    const isInitialMount = prevLength.current === 0 && shown.length > 0;
    const isShrink = prevLength.current > 0 && shown.length < prevLength.current;
    const prevKeyStillPresent = prevKey ? shown.some((s) => s.key === prevKey) : false;
    const isNewChat = prevKey !== null && !prevKeyStillPresent && shown.length > 0;
    const grewAtEnd = shown.length > prevLength.current && shown[shown.length - 1]?.key !== prevLast;
    // Settle-swap: the authoritative rebuild replaces live rows with
    // same-length rows under new keys (local streaming keys vs stable
    // hydrate keys). While pinned that is still "new content at the tail"
    // and must follow, otherwise the viewport strands above the bottom.
    const tailSwapped = shown.length > 0 && shown.length === prevLength.current && shown[shown.length - 1]?.key !== prevLast;
    const prepended = !isNewChat && shown.length > 0 && prevKey !== null && shown[0]?.key !== prevKey && !isShrink && prevKeyStillPresent;
    const before = prevHeight.current;
    prevHeight.current = el.scrollHeight;
    prevFirstKey.current = shown[0]?.key ?? null;
    prevLastKey.current = shown[shown.length - 1]?.key ?? null;
    prevLength.current = shown.length;
    if (prepended && before > 0) {
      requestAnimationFrame(() => {
        if (ref.current) ref.current.scrollTop += ref.current.scrollHeight - before;
      });
      return;
    }
    if (isInitialMount || isNewChat || ((grewAtEnd || tailSwapped) && stick.current && Date.now() - lastUserScrollAt.current > 800)) {
      requestAnimationFrame(() => {
        if (ref.current && (isInitialMount || isNewChat || stick.current)) pinToBottom();
      });
    }
  }, [shown]);

  // Follow content growth while pinned. Observing the inner column (not the
  // scroller) fires when message/tool/reasoning/code height changes; the
  // `stick` gate is what keeps this from ever fighting an intentional
  // scroll-up. Direct assignment (no smooth scrolling) avoids oscillation
  // when tool output grows several frames in a row.
  useEffect(() => {
    const el = ref.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!stick.current || Date.now() < followSuspendUntil.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (ref.current && stick.current && Date.now() >= followSuspendUntil.current) pinToBottom();
      });
    });
    ro.observe(inner);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  // Derived view data: rebuilt only when the transcript actually changes, not
  // on every parent render (streaming deltas re-render App many times/sec).
  const historyById = useMemo(() => new Map(historyTurns.map((turn) => [turn.entryId, turn])), [historyTurns]);

  // A turn spans from a user message up to (but not including) the next user
  // message. Attach a "files changed" card after the last item of each turn
  // that recorded a completed filesystem checkpoint.
  const cards = useMemo(() => {
    const nextCards = new Map<number, HistoryTurn>();
    let turnStart = -1;
    for (let i = 0; i < shown.length; i++) {
      const item = shown[i];
      if (item === undefined) continue;
      if (item.kind === "user") {
        if (turnStart >= 0) {
          const start = shown[turnStart];
          const turn = start !== undefined && start.kind === "user" && start.entryId ? historyById.get(start.entryId) : undefined;
          if (turn) nextCards.set(i - 1, turn);
        }
        turnStart = i;
      }
    }
    if (turnStart >= 0) {
      const start = shown[turnStart];
      const turn = start !== undefined && start.kind === "user" && start.entryId ? historyById.get(start.entryId) : undefined;
      if (turn) nextCards.set(shown.length - 1, turn);
    }
    return nextCards;
  }, [shown, historyById]);
  const latestChanged = useMemo(() => [...historyTurns].reverse().find((turn) => turn.changedCount > 0), [historyTurns]);
  // Virtualization decision, latched per transcript load: flipping
  // content-visibility mid-stream collapses offscreen size estimates and
  // yanks scrollHeight under the follow logic (one flaky stranded-above-
  // bottom per crossing). Keyed on the transcript identity (first item key),
  // so it re-evaluates only when the transcript empties (new chat / session
  // switch), never while a session grows. A render-phase ref mutation used
  // to do this; a memo is safe under concurrent rendering.
  const loadId = items.length === 0 ? "" : (items[0]?.key ?? "");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const longChat = useMemo(() => items.length > 60, [loadId]);

  // t3-style turn folding: each user message starts a turn. Settled turns
  // (not the live one) collapse behind a single "Worked for" row.
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set());
  const userIndices = useMemo(() => {
    const idxs: number[] = [];
    for (let i = 0; i < shown.length; i++) if (shown[i]?.kind === "user") idxs.push(i);
    return idxs;
  }, [shown]);
  const foldMap = useMemo(
    () => buildTurnFolds(shown, userIndices, (i) => cards.has(i)),
    [shown, userIndices, cards]
  );
  const isFoldCollapsed = (turnId: string) => !expandedTurns.has(turnId) && turnId !== liveTurnId;
  // With streaming responses on, the live (last) turn renders fully expanded
  // while the agent runs so the stream is visible; the moment the run settles
  // it folds to just the final message. The non-streaming path keeps turns
  // folded throughout, unchanged.
  const liveTurnId = useMemo(() => {
    if (!streamResponses || !streaming) return null;
    let last: string | null = null;
    let lastStart = -1;
    for (const [, fold] of foldMap) {
      if (fold.start > lastStart) {
        lastStart = fold.start;
        last = fold.turnId;
      }
    }
    return last;
  }, [foldMap, streaming, streamResponses]);
  const findMatches = useMemo(
    () => (findOpen ? findTranscriptMatches(shown, findQuery) : []),
    [findOpen, shown, findQuery]
  );
  const findActive =
    findMatches.length > 0
      ? findMatches[((findIdx % findMatches.length) + findMatches.length) % findMatches.length]
      : null;
  // Jump to the active hit: expand its fold first (the row mounts on the
  // next paint), then scroll it into view with a flash ring.
  useEffect(() => {
    if (!findOpen || !findActive) return;
    for (const fold of foldMap.values()) {
      if (
        findActive.index >= fold.start &&
        findActive.index < fold.end &&
        !expandedTurns.has(fold.turnId) &&
        fold.turnId !== liveTurnId
      ) {
        setExpandedTurns((prev) => new Set(prev).add(fold.turnId));
        return;
      }
    }
    const id = requestAnimationFrame(() => {
      const el = itemEls.current.get(findActive.key);
      // Explicit navigation: mark input so the jump's own scroll events
      // may break follow. Marking (not forcing) keeps already-centered
      // matches exactly as pinned as they were.
      lastInputAt.current = Date.now();
      el?.scrollIntoView?.({ block: "center" });
      clearFindFlash();
      el?.classList.add("find-target-flash");
    });
    return () => cancelAnimationFrame(id);
  }, [findOpen, findActive, foldMap, expandedTurns, liveTurnId, clearFindFlash]);
  // Terminal replies of collapsed turns: their reasoning block is work too, so
  // it stays hidden until the turn is expanded.
  const collapsedTerminals = useMemo(() => {
    const set = new Set<number>();
    for (const fold of foldMap.values()) {
      if (fold.terminalIdx >= 0 && !expandedTurns.has(fold.turnId) && fold.turnId !== liveTurnId) set.add(fold.terminalIdx);
    }
    return set;
  }, [foldMap, expandedTurns, liveTurnId]);
  // All hidden indices regardless of expanded state, kept out of the flat
  // visibleEntries list so hidden tools render only inside the animated
  // fold container (interruptible spring, 0fr ↔ 1fr).
  const allHiddenIndices = useMemo(() => {
    const set = new Set<number>();
    for (const [, fold] of foldMap) {
      let terminalIdx = -1;
      for (let i = fold.start + 1; i < fold.end; i++) {
        if (shown[i]?.kind === "assistant") terminalIdx = i;
      }
      for (let i = fold.start + 1; i < fold.end; i++) {
        if (i === terminalIdx) continue;
        if (cards.has(i)) continue;
        set.add(i);
      }
    }
    return set;
  }, [foldMap, shown, cards]);
  const entries = useMemo(() => buildEntries(shown), [shown]);

  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      <div
        ref={ref}
        onScroll={onScroll}
        onWheel={() => {
          lastInputAt.current = Date.now();
        }}
        onTouchMove={() => {
          lastInputAt.current = Date.now();
        }}
        onPointerDown={(e) => {
          if (e.button === 0) lastPointerDown.current = Date.now();
        }}
        onPointerMove={(e) => {
          // Scrollbar/thumb and content drags (buttons held) are genuine
          // movement; hover moves never mark input.
          if (e.buttons > 0 && Date.now() - lastPointerDown.current < 30_000) {
            lastInputAt.current = Date.now();
          }
        }}
        className="conversation-scroll flex-1 min-h-0 overflow-y-auto"
        role="log"
        aria-live="off"
        aria-label="Conversation"
      >
      <div ref={innerRef} className="conversation-column mx-auto flex flex-col px-4 py-6 sm:px-6">
        {loadingEarlier ? (
          <div className="mb-3 flex items-center gap-2 text-[12px] text-dim" aria-live="polite">
            <span className="spinner inline-block h-3 w-3 rounded-full border-[1.5px] border-line border-t-accent" />
            Loading earlier messages…
          </div>
        ) : null}
        {items.length === 0 ? (
          <div className="conversation-empty">
            <h2>{projectName ? `What are we doing in ${projectName}?` : "What should Pi work on?"}</h2>
            <p>{streaming ? "Preparing this session…" : "Describe the change, question, or outcome you want."}</p>
          </div>
        ) : null}
        {(() => {
          const visibleEntries = entries.filter((e) => !allHiddenIndices.has(e.index));
          return visibleEntries.map((entry, idx) => {
            const foldForUser = entry.type === "single" && entry.item.kind === "user" ? foldMap.get(entry.index) : undefined;
            const isCollapsed = foldForUser ? isFoldCollapsed(foldForUser.turnId) : false;
            const hiddenEntriesForFold = foldForUser
              ? (() => {
                  const slice = shown.slice(foldForUser.start + 1, foldForUser.end).filter((_, i) => allHiddenIndices.has(foldForUser.start + 1 + i));
                  return slice.length ? buildEntries(slice) : [];
                })()
              : [];
            return entry.type === "group" ? (
              <Fragment key={`g-${entry.index}`}>
                <div className={longChat ? "chat-item chat-item-long" : "chat-item"}>
                  <ToolGroup tools={entry.tools} onDisclosureToggle={suspendFollowForDisclosure} />
                </div>
                {cards.get(entry.index) ? (
                  <TurnChanges turn={cards.get(entry.index)!} isLatest={latestChanged?.entryId === cards.get(entry.index)!.entryId} />
                ) : null}
              </Fragment>
            ) : (
              <Fragment key={entry.item.key}>
                <div ref={trackItemEl(entry.item.key)} className={longChat ? "chat-item chat-item-long" : "chat-item"}>
                  {(() => {
                    const prev = idx > 0 ? visibleEntries[idx - 1] : null;
                    const prevIsTool = !!prev && (prev.type === "group" || (prev.type === "single" && (prev.item.kind === "tool" || prev.item.kind === "launch")));
                    const showTopDivider = entry.item.kind === "assistant" && prevIsTool;
                    return (
                      <>
                        {showTopDivider ? <hr className="assistant-divider" /> : null}
                        {entry.item.kind === "user" ? (
                          <UserMessage item={entry.item} historyTurn={entry.item.entryId ? historyById.get(entry.item.entryId) : undefined} rollbackDisabled={streaming} onRollback={onRollback} hideActions={foldForUser != null} />
                        ) : entry.item.kind === "assistant" ? (
                          <>
                            <SpeakerHead speaker={entry.item.speaker} streaming={entry.item.streaming} roomHandle={roomHandle} members={roomMembers} isRoom={isRoom} roomName={roomName} showSpeakers={showSpeakers} />
                            <AssistantMessage item={entry.item} hideThinking={isRoom || collapsedTerminals.has(entry.index)} />
                          </>
                        ) : entry.item.kind === "tool" ? (
                          <ToolCard item={entry.item} onDisclosureToggle={suspendFollowForDisclosure} />
                        ) : entry.item.kind === "recap" ? (
                          <RecapLine text={entry.item.text} />
                        ) : entry.item.kind === "launch" ? (
                          <LaunchCard item={entry.item} onOpen={onOpenLaunch} onControl={onControlLaunch} />
                        ) : entry.item.kind === "compaction" ? (
                          <CompactionCard item={entry.item} />
                        ) : (
                          <SystemLine text={entry.item.text} />
                        )}
                      </>
                    );
                  })()}
                </div>
                {foldForUser ? (
                  <>
                    <div className="turn-fold my-0.5 flex w-full items-center gap-2 rounded-md border-b border-line/60 px-2 py-1 text-left text-[11px] text-dim">
                      <button
                        type="button"
                        aria-expanded={isCollapsed ? "false" : "true"}
                        aria-label={isCollapsed ? `Expand ${foldForUser.hiddenCount} hidden steps: ${foldForUser.label}` : `Collapse turn: ${foldForUser.label}`}
                        onPointerDown={(e) => e.currentTarget.setPointerCapture?.(e.pointerId)}
                        onClick={() =>
                          setExpandedTurns((prev) => {
                            suspendFollowForDisclosure();
                            const n = new Set(prev);
                            if (isCollapsed) n.add(foldForUser.turnId);
                            else n.delete(foldForUser.turnId);
                            return n;
                          })
                        }
                        className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-fg"
                      >
                        <span className="truncate">{isCollapsed ? foldForUser.label : "Hide details"}</span>
                        <span className="ml-auto shrink-0 text-[length:var(--chat-r-11)]">{isCollapsed ? (foldForUser.hiddenCount > 0 ? `${foldForUser.hiddenCount} hidden` : "Show") : "Collapse"}</span>
                      </button>
                      {(() => {
                        // The turn's Rollback lives here, not on a floating
                        // chip: the absolutely-positioned message actions
                        // overlap this full-width row. Turns without a fold
                        // keep the floating chip in UserMessage.
                        const userEntryId = entry.item.kind === "user" ? entry.item.entryId : undefined;
                        const turn = userEntryId ? historyById.get(userEntryId) : undefined;
                        if (!onRollback || !userEntryId || !turn) return null;
                        const disabled = streaming || !turn.rollbackAvailable;
                        return (
                          <button
                            type="button"
                            onClick={() => onRollback(userEntryId)}
                            disabled={disabled}
                            title={streaming ? "Finish or stop the active response before rolling back" : turn.rollbackReason ?? "Rollback conversation and files from this turn"}
                            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-dim hover:text-fg disabled:opacity-40"
                          >
                            Rollback
                          </button>
                        );
                      })()}
                    </div>
                    <div
                      className="grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] will-change-[grid-template-rows]"
                      style={{ gridTemplateRows: isCollapsed ? "0fr" : "1fr" }}
                    >
                      <div className="overflow-hidden">
                        {hiddenEntriesForFold.map((he) =>
                          he.type === "group" ? (
                            <div key={`h-${he.index}`} className={longChat ? "chat-item chat-item-long" : "chat-item"}>
                              <ToolGroup tools={he.tools} onDisclosureToggle={suspendFollowForDisclosure} />
                            </div>
                          ) : (
                            <div ref={trackItemEl(he.item.key)} key={he.item.key} className={longChat ? "chat-item chat-item-long" : "chat-item"}>
                              {he.item.kind === "user" ? (
                                <UserMessage item={he.item} historyTurn={he.item.entryId ? historyById.get(he.item.entryId) : undefined} rollbackDisabled={streaming} onRollback={onRollback} />
                              ) : he.item.kind === "assistant" ? (<>
                                <SpeakerHead speaker={he.item.speaker} streaming={he.item.streaming} roomHandle={roomHandle} members={roomMembers} isRoom={isRoom} roomName={roomName} showSpeakers={showSpeakers} />
                                <AssistantMessage item={he.item} hideThinking={isRoom} />
                              </>) : he.item.kind === "tool" ? (
                                <ToolCard item={he.item} onDisclosureToggle={suspendFollowForDisclosure} />
                              ) : he.item.kind === "recap" ? (
                                <RecapLine text={he.item.text} />
                              ) : he.item.kind === "launch" ? (
                                <LaunchCard item={he.item} onOpen={onOpenLaunch} onControl={onControlLaunch} />
                              ) : he.item.kind === "compaction" ? (
                                <CompactionCard item={he.item} />
                              ) : (
                                <SystemLine text={he.item.text} />
                              )}
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  </>
                ) : null}
                {!foldForUser || !isCollapsed ? (cards.get(entry.index) ? (
                  <TurnChanges turn={cards.get(entry.index)!} isLatest={latestChanged?.entryId === cards.get(entry.index)!.entryId} />
                ) : null) : null}
              </Fragment>
            );
          });
        })()}
        {(isRoom || showSpeakers) && streaming && roomHandle ? (
          <div className="chat-item">
            <p className="my-2 flex items-center gap-2 text-[12px] text-dim" aria-live="polite">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
              @{roomHandle} is thinking…
            </p>
          </div>
        ) : null}
      </div>
      </div>
      {findOpen ? (
        <div
          role="search"
          aria-label="Find in transcript"
          className="absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-raised py-1 pl-3 pr-1.5 shadow-lg"
        >
          <input
            autoFocus
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value);
              setFindIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setFindIdx((i) => (e.shiftKey ? i - 1 : i + 1));
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              }
            }}
            placeholder="Find in transcript"
            aria-label="Find in transcript"
            className="w-44 bg-transparent text-[12px] outline-none placeholder:text-dim"
          />
          <span aria-live="polite" className="min-w-8 shrink-0 text-center text-[11px] tabular-nums text-dim">
            {findMatches.length > 0 && findActive
              ? `${findMatches.indexOf(findActive) + 1}/${findMatches.length}`
              : findQuery.trim() ? "0" : "—"}
          </span>
          <button
            type="button"
            onClick={() => setFindIdx((i) => i - 1)}
            disabled={findMatches.length === 0}
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            className="grid h-6 w-6 place-items-center rounded-full text-dim hover:text-fg disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => setFindIdx((i) => i + 1)}
            disabled={findMatches.length === 0}
            aria-label="Next match"
            title="Next match (Enter)"
            className="grid h-6 w-6 place-items-center rounded-full text-dim hover:text-fg disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={closeFind}
            aria-label="Close find"
            title="Close find (Esc)"
            className="grid h-6 w-6 place-items-center rounded-full text-dim hover:text-fg"
          >
            ✕
          </button>
        </div>
      ) : null}
      {showJump && (
        <button
          type="button"
          onClick={() => {
            const el = ref.current;
            if (!el) return;
            setStick(true);
            lastUserScrollAt.current = 0;
            // Instant, never smooth: a smooth flight toward a moving target
            // lands short while streaming, and the short landing then reads
            // as scrolled-up and clears the follow we just set.
            pinToBottom();
          }}
          className="absolute bottom-4 right-4 z-10 grid h-8 w-8 place-items-center rounded-full border border-line bg-raised text-dim transition-colors hover:text-fg active:scale-[0.97]"
          aria-label="Jump to bottom"
          title="Jump to bottom"
        >
          <ArrowDownIcon size={14} />
        </button>
      )}
      {quoteSel && onQuote ? (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onQuote(formatBlockquote(quoteSel.text));
            window.getSelection()?.removeAllRanges();
            setQuoteSel(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuoteSel(null);
          }}
          style={{ left: quoteSel.x, top: quoteSel.y }}
          className="fixed z-[60] rounded-full border border-line bg-raised px-3 py-1.5 text-[12px] font-medium text-fg shadow-lg transition-colors hover:border-accent/40 hover:text-accent"
          aria-label="Quote selection in composer"
          title="Quote selection in composer"
        >
          Quote
        </button>
      ) : null}
    </div>
  );
});
