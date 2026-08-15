import { useEffect, useRef } from "react";
import type { ChatItem } from "../store";
import type { HistoryTurn } from "../bridge";
import { UserMessage, AssistantMessage, ToolCard, SystemLine, RecapLine } from "./items";

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

  const historyById = new Map(historyTurns.map((turn) => [turn.entryId, turn]));

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="conversation-scroll absolute inset-0 overflow-y-auto"
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
        {shown.map((item) => (
          <div
            key={item.key}
            className={items.length > 60 ? "chat-item chat-item-long" : "chat-item"}
          >
            {item.kind === "user" ? (
              <UserMessage item={item} historyTurn={item.entryId ? historyById.get(item.entryId) : undefined} rollbackDisabled={streaming} onRollback={onRollback} />
            ) : item.kind === "assistant" ? (
              <AssistantMessage item={item} />
            ) : item.kind === "tool" ? (
              <ToolCard item={item} />
            ) : item.kind === "recap" ? (
              <RecapLine text={item.text} />
            ) : (
              <SystemLine text={item.text} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
