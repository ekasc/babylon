import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ChatItem } from "../store";
import type { HistoryTurn } from "../bridge";
import { UserMessage, AssistantMessage, ToolCard, ToolGroup, SystemLine, RecapLine, LaunchCard } from "./items";
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
  chromeTop?: number;
  chromeBottom?: number;
  historyTurns?: HistoryTurn[];
  onRollback?(entryId: string): void;
  onOpenLaunch?(runId: string, runKind: "subagent" | "thread" | "workflow"): void;
}

function summarizeTurnTools(tools: Array<Extract<ChatItem, { kind: "tool" }>>): string {
  let reads = 0;
  let edits = 0;
  let commands = 0;
  let other = 0;
  for (const t of tools) {
    const details: any = (t as any).details;
    const hasPatch = typeof details?.patch === "string" && details.patch.trim().length > 0;
    const name = (t.name ?? "").toLowerCase();
    if (hasPatch || name.includes("edit") || name.includes("write")) edits++;
    else if (name === "bash" || name.includes("bash") || name.includes("shell") || name.includes("command")) commands++;
    else if (name.includes("read") || name.includes("grep") || name.includes("glob")) reads++;
    else other++;
  }
  const parts: string[] = [];
  if (reads) parts.push(`Read ${reads} ${reads === 1 ? "file" : "files"}`);
  if (edits) parts.push(`Changed ${edits} ${edits === 1 ? "file" : "files"}`);
  if (commands) parts.push(`Ran ${commands} ${commands === 1 ? "command" : "commands"}`);
  if (other) parts.push(`Used ${other} ${other === 1 ? "tool" : "tools"}`);
  if (parts.length === 0) return "Worked";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1].toLowerCase()}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1].toLowerCase()}`;
}

export default function ChatView({
  items,
  renderCount,
  canLoadMore = false,
  loadingEarlier = false,
  onNeedEarlier,
  streaming,
  chromeTop = 66,
  chromeBottom = 156,
  historyTurns = [],
  onRollback,
  onOpenLaunch,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevHeight = useRef(0);
  const prevFirstKey = useRef<string | null>(null);
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
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    // Scroll-up streaming: near the top of the loaded region, ask for the next
    // older window. The App guards against duplicate concurrent fetches.
    if (el.scrollTop < 400 && canLoadMoreRef.current) {
      onNeedEarlierRef.current?.();
    }
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prepended = shown.length > 0 && prevFirstKey.current !== null && shown[0].key !== prevFirstKey.current;
    const before = prevHeight.current;
    prevHeight.current = el.scrollHeight;
    prevFirstKey.current = shown[0]?.key ?? null;
    const frame = requestAnimationFrame(() => {
      if (!el) return;
      if (stick.current) {
        el.scrollTop = el.scrollHeight;
      } else if (prepended && before > 0) {
        // Older messages were inserted above the viewport: keep the visible
        // content in place by shifting the scroll position by the inserted
        // height instead of letting the document jump.
        el.scrollTop += el.scrollHeight - before;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [shown]);

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
          if (turn && turn.changedCount > 0) nextCards.set(i - 1, turn);
        }
        turnStart = i;
      }
    }
    if (turnStart >= 0) {
      const start = shown[turnStart];
      const turn = start.kind === "user" && start.entryId ? historyById.get(start.entryId) : undefined;
      if (turn && turn.changedCount > 0) nextCards.set(shown.length - 1, turn);
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
      if (isLatest) continue;
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
  const hiddenIndices = useMemo(() => {
    const set = new Set<number>();
    for (const [, fold] of foldMap) {
      if (!expandedTurns.has(fold.turnId)) {
        let terminalIdx = -1;
        for (let i = fold.start + 1; i < fold.end; i++) {
          if (shown[i]?.kind === "assistant") terminalIdx = i;
        }
        for (let i = fold.start + 1; i < fold.end; i++) {
          if (i === terminalIdx) continue;
          set.add(i);
        }
      }
    }
    return set;
  }, [foldMap, shown, expandedTurns]);
  const entries = useMemo(() => buildEntries(shown), [shown]);

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="conversation-scroll absolute inset-0 overflow-y-auto"
      role="log"
      aria-label="Conversation"
      style={{ paddingTop: chromeTop, paddingBottom: chromeBottom }}
    >
      <div className="conversation-column mx-auto flex flex-col px-7 py-8">
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
          const visibleEntries = entries.filter((e) => !hiddenIndices.has(e.index));
          return visibleEntries.map((entry, idx) => {
            const foldForUser = entry.type === "single" && entry.item.kind === "user" ? foldMap.get(entry.index) : undefined;
            const isCollapsed = foldForUser ? isFoldCollapsed(foldForUser.turnId) : false;
            return entry.type === "group" ? (
              <Fragment key={`g-${entry.tools[0].key}`}>
                <div className={longChat ? "chat-item chat-item-long" : "chat-item"}>
                  <ToolGroup tools={entry.tools} />
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
                          <AssistantMessage item={entry.item} />
                        ) : entry.item.kind === "tool" ? (
                          <ToolCard item={entry.item} />
                        ) : entry.item.kind === "recap" ? (
                          <RecapLine text={entry.item.text} />
                        ) : entry.item.kind === "launch" ? (
                          <LaunchCard item={entry.item} onOpen={onOpenLaunch} />
                        ) : (
                          <SystemLine text={entry.item.text} />
                        )}
                      </>
                    );
                  })()}
                </div>
                {foldForUser && isCollapsed ? (
                  <>
                    <button
                      type="button"
                      aria-expanded="false"
                      aria-label={`Expand turn: ${foldForUser.label}`}
                      onClick={() => setExpandedTurns((prev) => { const n = new Set(prev); n.add(foldForUser.turnId); return n; })}
                      className="my-1 flex w-full items-center gap-2 rounded-md border border-dashed border-line bg-inset/50 px-3 py-1.5 text-left text-[12.5px] text-dim hover:border-line-strong hover:text-fg"
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--dim)]" aria-hidden />
                      <span>{foldForUser.label}</span>
                      <span className="ml-auto text-[11px]">{foldForUser.hiddenCount} steps hidden — click to expand</span>
                    </button>
                    {cards.get(foldForUser.end - 1) ? (
                      <TurnChanges turn={cards.get(foldForUser.end - 1)!} isLatest={latestChanged?.entryId === cards.get(foldForUser.end - 1)!.entryId} />
                    ) : null}
                  </>
                ) : foldForUser && !isCollapsed ? (
                  <button
                    type="button"
                    aria-expanded="true"
                    aria-label={`Collapse turn: ${foldForUser.label}`}
                    onClick={() => setExpandedTurns((prev) => { const n = new Set(prev); n.delete(foldForUser.turnId); return n; })}
                    className="my-1 flex w-full items-center justify-center rounded-md border border-line bg-transparent px-3 py-1 text-[12px] text-dim hover:text-fg"
                  >
                    Collapse
                  </button>
                ) : null}
                {!foldForUser || !isCollapsed ? (cards.get(entry.index) ? (
                  <TurnChanges turn={cards.get(entry.index)!} isLatest={latestChanged?.entryId === cards.get(entry.index)!.entryId} />
                ) : null) : null}
              </Fragment>
            );
          });
        })()}
      </div>
    </div>
  );
}
