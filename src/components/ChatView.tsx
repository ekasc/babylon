import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatItem } from "../store";
import { buildTurnFolds } from "../lib/chat-folds";
import {
  TURN_OVERSCAN,
  applyMeasuredHeight,
  buildTurnViewModels,
  estimateTurnHeight,
  findTurnIndexForItem,
  getMeasuredHeight,
  groupContiguousRuns,
  layoutTurns,
  resolveVisibleTurnRange,
  setMeasuredHeight,
  widthInvalidatesCache,
  type TurnEntry as Entry,
  type TurnMeasurements,
  type TurnViewModel,
  type TurnWindow,
} from "../lib/chat-turns";
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
  /** Owning session identity (path). The virtualization latch resets when
   *  this changes — same contract as Composer's draft key. */
  sessionKey?: string | null;
  /** Project of the viewed conversation. Design review captures are files
   *  under this project, so the block needs it to resolve them. */
  sessionCwd?: string | null;
}

/** Stored virtualization latch. */
export interface ChatVirtualization {
  sessionKey: string | null;
  latched: boolean;
}

/** Render-time virtualization decision (pure, unit-tested). A session
 *  switch reads the NEW transcript immediately — never the old latch —
 *  so the first render after a switch is already correct, before the
 *  effect below synchronizes the stored latch. */
export function resolveLongChat(
  stored: ChatVirtualization,
  sessionKey: string | null,
  itemCount: number,
): boolean {
  if (stored.sessionKey !== sessionKey) return itemCount > 60;
  return stored.latched;
}

/**
 * Shared empty turns list. A `historyTurns = []` default would allocate a
 * fresh array per render, defeating the historyById/cards/foldMap memo
 * chain (O(turns) recompute on every parent re-render).
 */
const NO_TURNS: HistoryTurn[] = [];

export default memo(function ChatView({
  items,
  canLoadMore = false,
  loadingEarlier = false,
  onNeedEarlier,
  streaming,
  historyTurns = NO_TURNS,
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
  sessionKey = null,
  sessionCwd = null,
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
    // Window the turn list around the new viewport (state updates only when
    // the band actually moves, so scrolling stays cheap).
    const next = computeWin(el.scrollTop);
    setWin((prev) => (sameWin(prev, next) ? prev : next));
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
  // Virtualization decision, latched per session: flipping
  // content-visibility mid-stream collapses offscreen size estimates and
  // yanks scrollHeight under the follow logic (one flaky stranded-above-
  // bottom per crossing). Explicit state, not useMemo: memo values may be
  // discarded at any time, and the old first-item-key changed whenever
  // earlier history loaded. One state object so the reset follows the
  // session identity: a switch re-evaluates from the NEW transcript
  // (never the old latch), growth latches on, emptying unlatches. The
  // render reads through the session check so a switch is correct on its
  // very first render, before the effect synchronizes the stored latch.
  const [virtualization, setVirtualization] = useState({ sessionKey, latched: items.length > 60 });
  useEffect(() => {
    setVirtualization((prev) => {
      if (prev.sessionKey !== sessionKey) {
        return { sessionKey, latched: items.length > 60 };
      }
      if (!prev.latched && items.length > 60) return { ...prev, latched: true };
      if (items.length === 0) return { ...prev, latched: false };
      return prev;
    });
  }, [sessionKey, items.length]);
  const longChat = resolveLongChat(virtualization, sessionKey, items.length);

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

  // ---- Turn-level windowing (virtualization) ----
  // Turns (not items) are the mount unit: settled offscreen turns become
  // spacers, the streaming turn and find targets mount as islands. The flat
  // entries/visibleEntries memos above stay intact (cheap array work); only
  // DOM mounting is windowed. content-visibility remains as an extra
  // browser-level optimization for mounted turns, never the primitive.
  const turns = useMemo(
    () =>
      buildTurnViewModels({
        entries,
        itemCount: shown.length,
        userIndices,
        userIdAt: (start) => {
          const item = shown[start];
          return item?.kind === "user" ? (item.entryId ?? item.key) : null;
        },
        foldAt: (start) => foldMap.get(start),
        liveTurnId,
        isCollapsed: (id) => !expandedTurns.has(id) && id !== liveTurnId,
        streaming,
      }),
    [entries, shown, userIndices, foldMap, liveTurnId, expandedTurns, streaming]
  );

  // Session-scoped measured heights (never shared across sessions).
  const measureCacheRef = useRef<TurnMeasurements>(new Map());
  const [heightsTick, setHeightsTick] = useState(0);
  const turnHeights = useMemo(() => {
    void heightsTick;
    const estimate = estimateTurnHeight(measureCacheRef.current, sessionKey);
    return turns.map((t) => getMeasuredHeight(measureCacheRef.current, sessionKey, t.id) ?? estimate);
  }, [turns, sessionKey, heightsTick]);
  const { offsets: turnOffsets, total: turnsTotal } = useMemo(() => layoutTurns(turnHeights), [turnHeights]);

  // Live mirrors for the ResizeObserver callback (stable instance).
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const offsetsRef = useRef(turnOffsets);
  offsetsRef.current = turnOffsets;
  const heightsRef = useRef(turnHeights);
  heightsRef.current = turnHeights;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  const [win, setWin] = useState<TurnWindow>({ start: 0, end: 0, extra: [] });
  const lastWinSession = useRef<string | null | undefined>(undefined);

  const computeWin = useCallback(
    (
      scrollTop: number,
      turnsArg: TurnViewModel[] = turnsRef.current,
      offsetsArg: number[] = offsetsRef.current,
      heightsArg: number[] = heightsRef.current
    ): TurnWindow => {
      const el = ref.current;
      const viewportHeight = el?.clientHeight ?? 800;
      const pinned: number[] = [];
      const liveIdx = turnsArg.findIndex((t) => t.live);
      if (liveIdx >= 0) pinned.push(liveIdx);
      if (findActive) {
        const found = findTurnIndexForItem(turnsArg, findActive.index);
        if (found >= 0) pinned.push(found);
      }
      return resolveVisibleTurnRange({
        turnCount: turnsArg.length,
        scrollTop,
        viewportHeight,
        offsets: offsetsArg,
        heights: heightsArg,
        overscanTurns: TURN_OVERSCAN,
        pinned,
      });
    },
    [findActive]
  );

  const sameWin = useCallback((a: TurnWindow, b: TurnWindow): boolean => {
    return a.start === b.start && a.end === b.end && a.extra.join(",") === b.extra.join(",");
  }, []);

  // Recompute the window when turns, layout, ownership, or session change.
  // A session switch resets to the bottom band (measurements retained per
  // session); anything else re-resolves against the live scroll position so
  // a settled user's viewport never moves under them. Layout effect (not
  // passive): the corrected band must commit before paint, otherwise a
  // prepend/switch flashes one wrong-band frame and the passive pin/follow
  // effects below measure a stale scrollHeight.
  useLayoutEffect(() => {
    const el = ref.current;
    if (sessionKey !== lastWinSession.current) {
      lastWinSession.current = sessionKey;
      const pinned: number[] = [];
      const liveIdx = turns.findIndex((t) => t.live);
      if (liveIdx >= 0) pinned.push(liveIdx);
      const bottom = Math.max(0, turns.length - (TURN_OVERSCAN * 2 + 1));
      setWin((prev) => {
        const next: TurnWindow = {
          start: bottom,
          end: turns.length,
          extra: pinned.filter((t) => t < bottom),
        };
        return sameWin(prev, next) ? prev : next;
      });
      return;
    }
    if (!el) return;
    const next = computeWin(el.scrollTop);
    setWin((prev) => (sameWin(prev, next) ? prev : next));
  }, [turns, turnOffsets, sessionKey, findActive, liveTurnId, computeWin, sameWin]);

  // Per-turn measurement. One ResizeObserver per turn container (not per
  // message): settled turns report once and go quiet; the streaming turn
  // reports as it grows. Height changes entirely above the viewport shift
  // scrollTop by the delta (anchor preservation); anything else only
  // refreshes the cache — notably, an expanding fold never fights the
  // viewport because its turn contains (or sits below) the visible area.
  // The old height is always the laid-out value (estimate included), read
  // before the cache insert — never recomputed after it.
  const turnObserver = useRef<ResizeObserver | null>(null);
  // Last conversation-column width: line wrapping (hence every turn height)
  // is width-dependent below the 810px column cap, and offscreen turns never
  // re-measure. A material change drops the whole cache (all sessions share
  // the width); mounted turns re-measure immediately, the rest on visit.
  const columnWidthRef = useRef<number | null>(null);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((records) => {
      const el = ref.current;
      const session = sessionKeyRef.current;
      // Phase 1 (order-independent): column width decision first, wherever
      // the column record sits in the batch. A width change clears stale
      // measurements BEFORE any turn record is stored — a turn entry
      // processed before the column entry must not be wiped by the clear
      // that follows it.
      let widthChanged = false;
      for (const record of records) {
        const target = record.target as HTMLElement;
        if (target !== innerRef.current) continue;
        const width = target.clientWidth;
        if (widthInvalidatesCache({ prevWidth: columnWidthRef.current, nextWidth: width })) {
          widthChanged = true;
        }
        columnWidthRef.current = width;
      }
      if (widthChanged) measureCacheRef.current.clear();
      // Phase 2: turn measurements. On a width change, measure every
      // mounted turn directly instead of trusting the batch: a turn whose
      // height happened not to change produces no useful resize entry, and
      // anything recorded pre-clear would already be gone. (~5–11 turns.)
      const turnTargets: HTMLElement[] = widthChanged
        ? [...turnEls.current.values()]
        : records
            .map((record) => record.target as HTMLElement)
            .filter((target) => target.dataset.turnId);
      let changed = widthChanged;
      for (const target of turnTargets) {
        const id = target.dataset.turnId;
        if (!id || !el) continue;
        const idx = turnsRef.current.findIndex((t) => t.id === id);
        if (idx < 0) continue;
        const height = target.offsetHeight;
        const laidOut = heightsRef.current[idx];
        const { scrollTop: adjusted, store } = applyMeasuredHeight({
          scrollTop: el.scrollTop,
          turnOffsetTop: offsetsRef.current[idx] ?? 0,
          laidOutHeight: laidOut,
          measuredHeight: height,
        });
        if (store) {
          setMeasuredHeight(measureCacheRef.current, session, id, height);
          changed = true;
        }
        if (adjusted !== el.scrollTop) el.scrollTop = adjusted;
      }
      if (changed) setHeightsTick((t) => t + 1);
    });
    turnObserver.current = ro;
    for (const turnEl of turnEls.current.values()) ro.observe(turnEl);
    if (innerRef.current) ro.observe(innerRef.current);
    return () => {
      ro.disconnect();
      if (turnObserver.current === ro) turnObserver.current = null;
    };
  }, []);
  const trackTurnEl = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      const ro = turnObserver.current;
      if (el) {
        turnEls.current.set(id, el);
        ro?.observe(el);
      } else {
        const prev = turnEls.current.get(id);
        if (prev) ro?.unobserve(prev);
        turnEls.current.delete(id);
      }
    },
    []
  );
  const turnEls = useRef(new Map<string, HTMLDivElement>());

  // Visible entries bucketed per turn (single pass; both sorted by index).
  // Only mounted turns render — the window slice below selects them.
  const turnSlices = useMemo(() => {
    const slices: Entry[][] = turns.map(() => []);
    const visible = entries.filter((e) => !allHiddenIndices.has(e.index));
    let t = 0;
    for (const entry of visible) {
      while (t + 1 < turns.length && entry.index >= (turns[t + 1]?.start ?? Infinity)) t++;
      const turn = turns[t];
      if (turn && entry.index >= turn.start && entry.index < turn.end) slices[t]!.push(entry);
    }
    return slices;
  }, [entries, turns, allHiddenIndices]);

  // Mounted runs with spacer gaps (offsets resolved against measured or
  // estimated heights). Turn divs below are keyed by stable turn id, so
  // sliding the window moves DOM instead of remounting it; spacers (cheap
  // empty divs) may remount freely.
  const mountedRuns = useMemo(() => {
    const all: number[] = [];
    for (let i = win.start; i < win.end; i++) all.push(i);
    for (const t of win.extra) all.push(t);
    const runs = groupContiguousRuns(all.filter((i) => i >= 0 && i < turns.length));
    const endOffset = (endEx: number) => (endEx >= turns.length ? turnsTotal : (turnOffsets[endEx] ?? turnsTotal));
    let prevBottom = 0;
    const decorated = runs.map((run) => {
      const top = turnOffsets[run.start] ?? 0;
      const gap = run.start === 0 ? 0 : Math.max(0, top - prevBottom);
      prevBottom = endOffset(run.end);
      return { ...run, gap };
    });
    return { runs: decorated, tail: Math.max(0, turnsTotal - prevBottom) };
  }, [win, turns.length, turnOffsets, turnsTotal]);

  const prevEntryBeforeTurn = useCallback(
    (ti: number): Entry | null => {
      for (let t = ti - 1; t >= 0; t--) {
        const slice = turnSlices[t];
        if (slice && slice.length > 0) return slice[slice.length - 1]!;
      }
      return null;
    },
    [turnSlices]
  );

  // One entry row (user/assistant/tool/group/card + fold bar + hidden
  // container). Extracted verbatim from the former full-list map so mounted
  // turns render byte-identical rows; `prev` crosses turn boundaries for the
  // assistant divider.
  const renderRow = (entry: Entry, prev: Entry | null) => {
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
          <ToolGroup tools={entry.tools} sessionFile={sessionKey} onDisclosureToggle={suspendFollowForDisclosure} />
        </div>
        {cards.get(entry.index) ? (
          <TurnChanges turn={cards.get(entry.index)!} isLatest={latestChanged?.entryId === cards.get(entry.index)!.entryId} sessionFile={sessionKey} />
        ) : null}
      </Fragment>
    ) : (
      <Fragment key={entry.item.key}>
        <div ref={trackItemEl(entry.item.key)} className={longChat ? "chat-item chat-item-long" : "chat-item"}>
          {(() => {
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
                  <ToolCard item={entry.item} sessionFile={sessionKey} cwd={sessionCwd} onDisclosureToggle={suspendFollowForDisclosure} />
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
            <div className="group/fold my-0.5 flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-dim">
              <button
                type="button"
                aria-expanded={isCollapsed ? "false" : "true"}
                aria-label={isCollapsed ? `Expand ${foldForUser.hiddenCount} hidden steps: ${foldForUser.label}` : `Collapse turn: ${foldForUser.label}`}
                onPointerDown={(e) => e.currentTarget.setPointerCapture?.(e.pointerId)}
                onClick={() =>
                  setExpandedTurns((prevTurns) => {
                    suspendFollowForDisclosure();
                    const n = new Set(prevTurns);
                    if (isCollapsed) n.add(foldForUser.turnId);
                    else n.delete(foldForUser.turnId);
                    return n;
                  })
                }
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-fg"
              >
                <span aria-hidden="true" className="text-[10px] leading-none">{isCollapsed ? "▸" : "▾"}</span>
                {isCollapsed ? (
                  <span className="truncate">
                    {foldForUser.label}
                    {(() => {
                      const filesChanged =
                        entry.item.kind === "user" && entry.item.entryId
                          ? (historyById.get(entry.item.entryId)?.changedCount ?? 0)
                          : 0;
                      return filesChanged > 0 ? ` · ${filesChanged} file${filesChanged === 1 ? "" : "s"} changed` : "";
                    })()}
                  </span>
                ) : (
                  <span>Hide details</span>
                )}
              </button>
              {(() => {
                // Rollback reveals on hover: the fold line is metadata, not chrome.
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
                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-dim opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 disabled:opacity-40 group-hover/fold:opacity-100"
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
                      <ToolGroup tools={he.tools} sessionFile={sessionKey} cwd={sessionCwd} onDisclosureToggle={suspendFollowForDisclosure} />
                    </div>
                  ) : (
                    <div ref={trackItemEl(he.item.key)} key={he.item.key} className={longChat ? "chat-item chat-item-long" : "chat-item"}>
                      {he.item.kind === "user" ? (
                        <UserMessage item={he.item} historyTurn={he.item.entryId ? historyById.get(he.item.entryId) : undefined} rollbackDisabled={streaming} onRollback={onRollback} />
                      ) : he.item.kind === "assistant" ? (<>
                        <SpeakerHead speaker={he.item.speaker} streaming={he.item.streaming} roomHandle={roomHandle} members={roomMembers} isRoom={isRoom} roomName={roomName} showSpeakers={showSpeakers} />
                        <AssistantMessage item={he.item} hideThinking={isRoom} />
                      </>) : he.item.kind === "tool" ? (
                        <ToolCard item={he.item} sessionFile={sessionKey} cwd={sessionCwd} onDisclosureToggle={suspendFollowForDisclosure} />
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
          <TurnChanges turn={cards.get(entry.index)!} isLatest={latestChanged?.entryId === cards.get(entry.index)!.entryId} sessionFile={sessionKey} />
        ) : null) : null}
      </Fragment>
    );
  };

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
        {mountedRuns.runs.flatMap((run) => {
          const out: ReactNode[] = [];
          if (run.gap > 0) {
            out.push(<div key={`sp-${run.start}`} aria-hidden="true" style={{ height: run.gap }} />);
          }
          for (let ti = run.start; ti < run.end; ti++) {
            const turn = turns[ti];
            if (!turn) continue;
            const rows = turnSlices[ti] ?? [];
            out.push(
              <div key={turn.id} ref={trackTurnEl(turn.id)} data-turn-id={turn.id}>
                {rows.map((entry, j) => renderRow(entry, j > 0 ? rows[j - 1]! : prevEntryBeforeTurn(ti)))}
              </div>
            );
          }
          return out;
        })}
        {mountedRuns.tail > 0 ? <div key="sp-tail" aria-hidden="true" style={{ height: mountedRuns.tail }} /> : null}
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
            // Mount the bottom band first so the pin measures real content
            // rather than the bottom spacer; the pin lands after paint.
            // Instant, never smooth: a smooth flight toward a moving target
            // lands short while streaming, and the short landing then reads
            // as scrolled-up and clears the follow we just set.
            setWin(computeWin(Number.MAX_SAFE_INTEGER));
            requestAnimationFrame(() => pinToBottom());
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
