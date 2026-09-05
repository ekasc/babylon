import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import type { ChatItem } from "../store";
import type { HistoryTurn } from "../bridge";
import type { Bot } from "../bots";
import { botHandle } from "../bots";
import { UserMessage, AssistantMessage, ToolCard, ToolGroup, SystemLine, RecapLine, LaunchCard } from "./items";
import { BotAvatar } from "./BotsPanel";
import { formatTokens } from "../lib/format";
import { formatTokensEffect } from "../lib/format.effect";
import * as Effect from "effect/Effect";

/** Group-room speaker header: avatar + name so member turns read as voices. */
export function MemberHeader({ handle, members }: { handle: string; members: Bot[] }) {
  const member = members.find((m) => botHandle(m) === handle);
  return (
    <div className="mb-1 flex min-w-0 items-center gap-1.5" data-room-speaker={handle}>
      <BotAvatar name={member?.name ?? handle} size={16} />
      <span className="truncate text-[13px] font-semibold">{member?.name ?? `@${handle}`}</span>
      {member?.title ? <span className="truncate text-[12px] text-dim">{member.title}</span> : null}
    </div>
  );
}

/** Group-room host header: the facilitator's own replies (answers to you
 *  directly, not member turns) get the room's identity, never a blank bubble. */
export function RoomHostHeader({ roomName }: { roomName: string }) {
  return (
    <div className="mb-1 flex min-w-0 items-center gap-1.5" data-room-host={roomName}>
      <BotAvatar name={roomName} size={16} />
      <span className="truncate text-[13px] font-semibold">{roomName}</span>
      <span className="truncate text-[12px] text-dim">host</span>
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
  const settled = !isCompacting && !isFailed && !isAborted;
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
      text = `${Effect.runSync(formatTokensEffect(r.tokensBefore))}→${Effect.runSync(formatTokensEffect(r.estimatedTokensAfter))}`;
    } else {
      text = "Compacted";
    }
    subtext = item.reason && item.reason !== "auto" ? item.reason : null;
    leading = "◍";
  }
  const mono = settled && text.includes("→");
  return (
    <div
      className={`my-3 flex w-fit items-center gap-2.5 rounded-md border px-3 py-1.5 text-[12px] ${isFailed ? "border-err/30 bg-err/10 text-err" : isAborted ? "border-warn/30 bg-warn/10 text-warn" : "border-line bg-inset/60 text-dim"}`}
      style={{ maxWidth: "100%" }}
      role="status"
      aria-live="polite"
    >
      {isCompacting ? <span className="spinner inline-block h-3 w-3 shrink-0 rounded-full border-[1.5px] border-line border-t-accent animate-spin" aria-hidden /> : null}
      {leading ? <span aria-hidden className={mono ? "font-mono" : undefined}>{leading}</span> : null}
      <span className={`font-medium ${mono ? "font-mono tabular-nums tracking-tight" : ""}`} style={{ color: isFailed || isAborted ? undefined : "var(--fg)" }}>{text}</span>
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
  /** Suffix window: render only the newest N items; grows upward when older
   *  transcript windows stream in. */
  renderCount?: number;
  /** True while an older stored-transcript window still exists. */
  canLoadMore?: boolean;
  loadingEarlier?: boolean;
  /** Called when the user scrolls to the top of the loaded region. */
  onNeedEarlier?(): void;
  streaming: boolean;
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
}

function summarizeTurnTools(tools: Array<Extract<ChatItem, { kind: "tool" }>>): string {
  const readFiles = new Set<string>();
  const editedFiles = new Set<string>();
  let readOps = 0;
  let editOps = 0;
  let commands = 0;
  let other = 0;
  for (const t of tools) {
    const details: any = (t as any).details;
    const args: any = (t as any).args;
    const hasPatch = typeof details?.patch === "string" && details.patch.trim().length > 0;
    const name = (t.name ?? "").toLowerCase();
    const filePath: string | null =
      (typeof args?.file_path === "string" && args.file_path) ||
      (typeof args?.path === "string" && args.path) ||
      (typeof details?.file === "string" && details.file) ||
      null;
    if (hasPatch || name.includes("edit") || name.includes("write")) {
      editOps++;
      if (filePath) editedFiles.add(filePath);
    } else if (name === "bash" || name.includes("bash") || name.includes("shell") || name.includes("command")) {
      commands++;
    } else if (name.includes("read") || name.includes("grep") || name.includes("glob")) {
      readOps++;
      if (filePath) readFiles.add(filePath);
    } else {
      other++;
    }
  }
  const reads = readFiles.size || readOps;
  const edits = editedFiles.size || editOps;
  const parts: string[] = [];
  if (reads) parts.push(`${reads} read${reads === 1 ? "" : "s"}`);
  if (edits) parts.push(`${edits} edit${edits === 1 ? "" : "s"}`);
  if (commands) parts.push(`${commands} command${commands === 1 ? "" : "s"}`);
  if (other) parts.push(`${other} tool${other === 1 ? "" : "s"}`);
  if (parts.length === 0) return "Worked";
  return parts.join(" \u00B7 ");
}

export default function ChatView({
  items,
  renderCount,
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
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastUserScrollAt = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const prevHeight = useRef(0);
  const prevFirstKey = useRef<string | null>(null);
  const prevLastKey = useRef<string | null>(null);
  const prevLength = useRef(0);
  const onNeedEarlierRef = useRef(onNeedEarlier);
  onNeedEarlierRef.current = onNeedEarlier;
  const canLoadMoreRef = useRef(canLoadMore);
  canLoadMoreRef.current = canLoadMore;

  // Latest-first: the visible window is the newest `renderCount` items, so a
  // big transcript opens showing the tail with no mount flicker.
  const shown = renderCount === undefined || renderCount >= items.length ? items : items.slice(items.length - renderCount);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = dist < 8;
    if (!atBottom) lastUserScrollAt.current = Date.now();
    const wasStick = stick.current;
    if (atBottom && !wasStick) stick.current = true;
    else if (!atBottom) stick.current = false;
    setShowJump(!stick.current);
    // Scroll-up streaming: near the top of the loaded region, ask for the next
    // older window. The App guards against duplicate concurrent fetches.
    if (el.scrollTop < 400 && canLoadMoreRef.current) {
      onNeedEarlierRef.current?.();
    }
  };

  // Pin on first open and on new-chat switch, and on genuine appends at
  // the end when the user is still following. Fold expand / streaming
  // deltas (same item grows) do NOT pin via this path, streaming uses
  // ResizeObserver below. `prepended` is only for "load earlier" where
  // the old first item is still visible in the new window.
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
    if (isInitialMount || isNewChat || (grewAtEnd && stick.current && Date.now() - lastUserScrollAt.current > 800)) {
      requestAnimationFrame(() => {
        if (ref.current && (isInitialMount || isNewChat || stick.current)) ref.current.scrollTop = ref.current.scrollHeight;
      });
    }
  }, [shown]);

  // Auto-pin via ResizeObserver disabled per user request, was pulling
  // the viewport to bottom on every streaming delta / tool output.
  // Keeping the observer disconnected entirely; use "Jump to bottom"
  // button to return. Re-enable by restoring this effect.
  // useEffect(() => { ... ResizeObserver ... }, [streaming]);

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
  const longChat = items.length > 60;

  // t3-style turn folding: each user message starts a turn. Settled turns
  // (not the live one) collapse behind a single "Worked for" row.
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set());
  const userIndices = useMemo(() => {
    const idxs: number[] = [];
    for (let i = 0; i < shown.length; i++) if (shown[i].kind === "user") idxs.push(i);
    return idxs;
  }, [shown]);
  const foldMap = useMemo(() => {
    const map = new Map<number, { turnId: string; label: string; hiddenCount: number; start: number; end: number }>();
    for (let t = 0; t < userIndices.length; t++) {
      const start = userIndices[t];
      const end = t + 1 < userIndices.length ? userIndices[t + 1] : shown.length;
      const isLatest = t === userIndices.length - 1;
      if (isLatest && streaming) continue;
      const slice = shown.slice(start + 1, end);
      const tools = slice.filter((it) => it.kind === "tool") as Array<Extract<ChatItem, { kind: "tool" }>>;
      const hasAssistant = slice.some((it) => it.kind === "assistant");
      if (!hasAssistant || tools.length === 0) continue;
      const hiddenCount = slice.filter((it) => it.kind !== "user").length - (hasAssistant ? 1 : 0);
      if (hiddenCount < 2) continue;
      const userItem = shown[start] as Extract<ChatItem, { kind: "user" }>;
      const turnId = userItem.entryId ?? userItem.key;
      if (!turnId) continue;
      map.set(start, {
        turnId,
        label: summarizeTurnTools(tools),
        hiddenCount,
        start,
        end,
      });
    }
    return map;
  }, [shown, userIndices, streaming]);
  const isFoldCollapsed = (turnId: string) => !expandedTurns.has(turnId);
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
        aria-label="Conversation"
      >
      <div ref={innerRef} className="conversation-column mx-auto flex flex-col px-7 py-8">
        {loadingEarlier ? (
          <div className="mb-3 flex items-center gap-2 text-[13px] text-dim" aria-live="polite">
            <span className="spinner inline-block h-3 w-3 rounded-full border-[1.5px] border-line border-t-accent" />
            Loading earlier messages…
          </div>
        ) : null}
        {items.length === 0 ? (
          <div className="conversation-empty">
            <h2>What should Pi work on?</h2>
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
            const stagger = Math.min(idx * 18, 120);
            return entry.type === "group" ? (
              <Fragment key={`g-${entry.tools[0].key}`}>
                <div className={longChat ? "chat-item chat-item-long" : "chat-item"} style={{ animationDelay: `${stagger}ms` } as any}>
                  <ToolGroup tools={entry.tools} staggerMs={stagger} />
                </div>
                {cards.get(entry.index) ? (
                  <TurnChanges turn={cards.get(entry.index)!} isLatest={latestChanged?.entryId === cards.get(entry.index)!.entryId} />
                ) : null}
              </Fragment>
            ) : (
              <Fragment key={entry.item.key}>
                <div className={longChat ? "chat-item chat-item-long" : "chat-item"} style={{ animationDelay: `${stagger}ms` } as any}>
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
                            <AssistantMessage item={entry.item} hideThinking={isRoom} />
                          </>
                        ) : entry.item.kind === "tool" ? (
                          <ToolCard item={entry.item} staggerMs={stagger} />
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
                          const n = new Set(prev);
                          if (isCollapsed) n.add(foldForUser.turnId);
                          else n.delete(foldForUser.turnId);
                          return n;
                        })
                      }
                      className="my-1 flex w-full items-center gap-2 rounded-md border border-line bg-inset/50 px-3 py-1.5 text-left text-[12px] text-dim transition-colors hover:border-line-strong hover:text-fg"
                    >
                      <span className="truncate">{isCollapsed ? foldForUser.label : "Hide details"}</span>
                      <span className="ml-auto shrink-0 text-[11px]">{isCollapsed ? `${foldForUser.hiddenCount} hidden` : "Collapse"}</span>
                    </button>
                    <div
                      className="grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] will-change-[grid-template-rows]"
                      style={{ gridTemplateRows: isCollapsed ? "0fr" : "1fr" }}
                    >
                      <div className="overflow-hidden">
                        {hiddenEntriesForFold.map((he) =>
                          he.type === "group" ? (
                            <div key={`h-${he.tools[0].key}`} className={longChat ? "chat-item chat-item-long" : "chat-item"}>
                              <ToolGroup tools={he.tools} />
                            </div>
                          ) : (
                            <div key={he.item.key} className={longChat ? "chat-item chat-item-long" : "chat-item"}>
                              {he.item.kind === "tool" ? <ToolCard item={he.item as any} /> : he.item.kind === "assistant" ? (<>
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
            <p className="my-2 flex items-center gap-2 text-[13px] text-dim" aria-live="polite">
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
            stick.current = true;
            setShowJump(false);
            lastUserScrollAt.current = 0;
            el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
          className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-inset active:scale-[0.97]"
          aria-label="Jump to bottom"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
}
