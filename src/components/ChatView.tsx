import { useEffect, useRef } from "react";
import type { ChatItem } from "../store";
import type { HistoryTurn } from "../bridge";
import { UserMessage, AssistantMessage, ToolCard, SystemLine } from "./items";

interface Props {
  items: ChatItem[];
  streaming: boolean;
  chromeTop?: number;
  chromeBottom?: number;
  historyTurns?: HistoryTurn[];
  onRollback?(entryId: string): void;
}

export default function ChatView({ items, streaming, chromeTop = 66, chromeBottom = 156, historyTurns = [], onRollback }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = ref.current;
      if (el && stick.current) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [items]);

  const historyById = new Map(historyTurns.map((turn) => [turn.entryId, turn]));

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="conversation-scroll absolute inset-0 overflow-y-auto"
      style={{ paddingTop: chromeTop, paddingBottom: chromeBottom }}
    >
      <div className="conversation-column mx-auto flex flex-col px-7 py-8">
        {items.length === 0 ? (
          <div className="conversation-empty">
            <h2>What should Pi work on?</h2>
            <p>{streaming ? "Preparing this session…" : "Describe the change, question, or outcome you want."}</p>
          </div>
        ) : null}
        {items.map((item) => (
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
            ) : (
              <SystemLine text={item.text} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
