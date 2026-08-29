import { Fragment, useEffect, useMemo, useRef } from "react";
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
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
  const entries = useMemo(() => buildEntries(shown), [shown]);
  const longChat = items.length > 60;

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
        {entries.map((entry, idx) =>
          entry.type === "group" ? (
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
                  const prev = idx > 0 ? entries[idx - 1] : null;
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
              {cards.get(entry.index) ? (
                <TurnChanges turn={cards.get(entry.index)!} isLatest={latestChanged?.entryId === cards.get(entry.index)!.entryId} />
              ) : null}
            </Fragment>
          )
        )}
      </div>
    </div>
  );
}
