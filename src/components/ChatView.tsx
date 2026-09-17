import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatItem } from "../store";
import { buildTurnFolds } from "../lib/chat-folds";
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
  let leading: string | null = null;
  let text: string;
  let subtext: string | null = null;
  if (isCompacting) {
    text = "Compacting…";
    subtext = item.reason ? `${item.reason}` : null;
  } else if (isAborted) {
    text = "Compaction aborted";
    leading = "○";
  } else if (isFailed) {
    text = "Compaction failed";
    subtext = item.error ?? null;
    leading = "⚠";
  } else {
    const r = item.result;
    if (r?.tokensBefore != null && r?.estimatedTokensAfter != null) {
      text = `${formatTokens(r.tokensBefore)}→${formatTokens(r.estimatedTokensAfter)}`;
    } else {
      text = "Compacted";
    }
    subtext = item.reason && item.reason !== "auto" ? item.reason : null;
    leading = "◍";
  }
  return (
    <div
      className={`my-3 flex w-fit items-center gap-2.5 rounded-md border px-3 py-1.5 text-[11px] ${isFailed ? "border-err/30 bg-err/10 text-err" : isAborted ? "border-warn/30 bg-warn/10 text-warn" : "border-line bg-inset/60 text-dim"}`}
      style={{ maxWidth: "100%" }}
      role="status"
      aria-live="polite"
    >
      {isCompacting ? <span className="spinner inline-block h-3 w-3 shrink-0 rounded-full border-[1.5px] border-line border-t-accent animate-spin" aria-hidden /> : null}
      {leading ? <span aria-hidden>{leading}</span> : null}
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
    if (shown[i].kind !== "tool") {
      entries.push({ type: "single", item: shown[i], index: i });
      i++;
      continue;
    }
    let j = i;
    while (j < shown.length && shown[j].kind === "tool") j++;
    const run = shown.slice(i, j) as Array<Extract<ChatItem, { kind: "tool" }>>;
    if (run.length >= TOOL_GROUP_MIN) {
      entries.push({ type: "group", tools: run, index: j - 1 });
    } else {
      for (let k = i; k < j; k++) entries.push({ type: "single", item: shown[k], index: k });
    }
    i = j;
  }
  return entries;
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
  onOpenLaunch,
  onControlLaunch,
  isRoom = false,
  roomHandle = null,
  roomMembers = [],
  roomName = "",
  showSpeakers = false,
  projectName = null,
  streamResponses = false,
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
  const showJumpVisible = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const setStick = (next: boolean) => {
    stick.current = next;
    if (showJumpVisible.current === next) {
      showJumpVisible.current = !next;
      setShowJump(!next);
    }
  };
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
  const onNeedEarlierRef = useRef(onNeedEarlier);
  onNeedEarlierRef.current = onNeedEarlier;
  const canLoadMoreRef = useRef(canLoadMore);
  canLoadMoreRef.current = canLoadMore;

  // The full transcript is always mounted: no suffix windowing, so scroll
  // position and continuity survive streaming, prepends, and rebuilds.
  const shown = items;

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const pin = lastPin.current;
    if (pin && Date.now() - pin.at < 500 && Math.abs(el.scrollTop - pin.target) < 4) {
      // Our own pin landing (possibly already stale by new growth): the user
      // didn't scroll, stay pinned and let the observer follow the growth.
      setStick(true);
    } else {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = dist < 32;
      if (!atBottom) lastUserScrollAt.current = Date.now();
      setStick(atBottom);
    }
    // Scroll-up streaming: near the top of the loaded region, ask for the next
    // older window. The App guards against duplicate concurrent fetches.
    if (el.scrollTop < 400 && canLoadMoreRef.current) {
      onNeedEarlierRef.current?.();
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
    const prepended = !isNewChat && shown.length > 0 && prevKey !== null && shown[0].key !== prevKey && !isShrink && prevKeyStillPresent;
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
      if (item.kind === "user") {
        if (turnStart >= 0) {
          const start = shown[turnStart];
          const turn = start.kind === "user" && start.entryId ? historyById.get(start.entryId) : undefined;
          if (turn) nextCards.set(i - 1, turn);
        }
        turnStart = i;
      }
    }
    if (turnStart >= 0) {
      const start = shown[turnStart];
      const turn = start.kind === "user" && start.entryId ? historyById.get(start.entryId) : undefined;
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
  const loadId = items.length === 0 ? "" : items[0].key;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const longChat = useMemo(() => items.length > 60, [loadId]);

  // t3-style turn folding: each user message starts a turn. Settled turns
  // (not the live one) collapse behind a single "Worked for" row.
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set());
  const userIndices = useMemo(() => {
    const idxs: number[] = [];
    for (let i = 0; i < shown.length; i++) if (shown[i].kind === "user") idxs.push(i);
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
                  return slice.length ? buildEntries(slice as any) : [];
                })()
              : [];
            return entry.type === "group" ? (
              <Fragment key={`g-${entry.tools[0].key}`}>
                <div className={longChat ? "chat-item chat-item-long" : "chat-item"}>
                  <ToolGroup tools={entry.tools} onDisclosureToggle={suspendFollowForDisclosure} />
                </div>
                {cards.get(entry.index) ? (
                  <TurnChanges turn={cards.get(entry.index)!} isLatest={latestChanged?.entryId === cards.get(entry.index)!.entryId} />
                ) : null}
              </Fragment>
            ) : (
              <Fragment key={entry.item.key}>
                <div className={longChat ? "chat-item chat-item-long" : "chat-item"}>
                  {(() => {
                    const prev = idx > 0 ? visibleEntries[idx - 1] : null;
                    const prevIsTool = !!prev && (prev.type === "group" || (prev.type === "single" && (prev.item.kind === "tool" || prev.item.kind === "launch")));
                    const showTopDivider = entry.item.kind === "assistant" && prevIsTool;
                    return (
                      <>
                        {showTopDivider ? <hr className="assistant-divider" /> : null}
                        {entry.item.kind === "user" ? (
                          <UserMessage item={entry.item} historyTurn={entry.item.entryId ? historyById.get(entry.item.entryId) : undefined} rollbackDisabled={streaming} onRollback={onRollback} />
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
                    <button
                      type="button"
                      aria-expanded={isCollapsed ? "false" : "true"}
                      aria-label={isCollapsed ? `Expand ${foldForUser.hiddenCount} hidden steps: ${foldForUser.label}` : `Collapse turn: ${foldForUser.label}`}
                      onPointerDown={(e) => (e.currentTarget as HTMLElement).setPointerCapture?.((e as any).pointerId)}
                      onClick={() =>
                        setExpandedTurns((prev) => {
                          suspendFollowForDisclosure();
                          const n = new Set(prev);
                          if (isCollapsed) n.add(foldForUser.turnId);
                          else n.delete(foldForUser.turnId);
                          return n;
                        })
                      }
                      className="turn-fold my-0.5 flex w-full items-center gap-2 rounded-md border-b border-line/60 px-2 py-1 text-left text-[11px] text-dim transition-colors hover:text-fg"
                    >
                      <span className="truncate">{isCollapsed ? foldForUser.label : "Hide details"}</span>
                      <span className="ml-auto shrink-0 text-[length:var(--chat-r-11)]">{isCollapsed ? (foldForUser.hiddenCount > 0 ? `${foldForUser.hiddenCount} hidden` : "Show") : "Collapse"}</span>
                    </button>
                    <div
                      className="grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] will-change-[grid-template-rows]"
                      style={{ gridTemplateRows: isCollapsed ? "0fr" : "1fr" }}
                    >
                      <div className="overflow-hidden">
                        {hiddenEntriesForFold.map((he) =>
                          he.type === "group" ? (
                            <div key={`h-${he.tools[0].key}`} className={longChat ? "chat-item chat-item-long" : "chat-item"}>
                              <ToolGroup tools={he.tools} onDisclosureToggle={suspendFollowForDisclosure} />
                            </div>
                          ) : (
                            <div key={he.item.key} className={longChat ? "chat-item chat-item-long" : "chat-item"}>
                              {he.item.kind === "tool" ? <ToolCard item={he.item as any} onDisclosureToggle={suspendFollowForDisclosure} /> : he.item.kind === "assistant" ? (<>
                                <SpeakerHead speaker={(he.item as any).speaker} streaming={(he.item as any).streaming} roomHandle={roomHandle} members={roomMembers} isRoom={isRoom} roomName={roomName} showSpeakers={showSpeakers} />
                                <AssistantMessage item={he.item as any} hideThinking={isRoom} />
                              </>) : <SystemLine text={(he.item as any).text} />}
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
      {showJump && (
        <button
          type="button"
          onClick={() => {
            const el = ref.current;
            if (!el) return;
            setStick(true);
            lastUserScrollAt.current = 0;
            el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
          className="absolute bottom-4 right-4 z-10 grid h-8 w-8 place-items-center rounded-full border border-line bg-raised text-dim transition-colors hover:text-fg active:scale-[0.97]"
          aria-label="Jump to bottom"
          title="Jump to bottom"
        >
          <ArrowDownIcon size={14} />
        </button>
      )}
    </div>
  );
});
