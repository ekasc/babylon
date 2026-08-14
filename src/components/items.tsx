import { memo, useEffect, useState } from "react";
import type { ChatItem } from "../store";
import { bridge, type HistoryTurn } from "../bridge";
import CodeBlock from "./CodeBlock";
import Markdown from "./Markdown";
import { ChevronIcon, ToolGlyph } from "./icons";

export const UserMessage = memo(function UserMessage({ item, historyTurn, rollbackDisabled, onRollback }: { item: Extract<ChatItem, { kind: "user" }>; historyTurn?: HistoryTurn; rollbackDisabled?: boolean; onRollback?(entryId: string): void }) {
  return (
    <article className="conversation-user group/user relative">
      <div className="whitespace-pre-wrap text-[15px] leading-[1.55]">
      {item.images && item.images.length > 0 && (
        <span className="mb-3 flex flex-wrap gap-2">
          {item.images.map((src, i) => (
            <img
              key={i}
              src={src}
              alt="attachment"
              loading="lazy"
              decoding="async"
              className="max-h-48 max-w-[260px] rounded-lg border border-line object-contain"
            />
          ))}
        </span>
      )}
      {item.text}
      </div>
      {item.entryId && historyTurn ? (
        <div className="user-message-actions" aria-label="Message actions">
          <button
            onClick={() => onRollback?.(item.entryId!)}
            disabled={rollbackDisabled || !historyTurn.rollbackAvailable || !onRollback}
            title={rollbackDisabled ? "Finish or stop the active response before rolling back" : historyTurn.rollbackReason ?? "Rollback conversation and files from this turn"}
          >
            Rollback
          </button>
        </div>
      ) : null}
    </article>
  );
});

const TextBlock = memo(function TextBlock({ text, streaming }: { text: string; streaming: boolean }) {
  return streaming ? (
    <div className="whitespace-pre-wrap leading-relaxed">{text}</div>
  ) : (
    <Markdown text={text} />
  );
});

export const AssistantMessage = memo(function AssistantMessage({ item }: { item: Extract<ChatItem, { kind: "assistant" }> }) {
  return (
    <article className="conversation-assistant">
      <div className="flex flex-col gap-3">
      {item.blocks.map((b, i) =>
        b.type === "text" ? (
          <div key={i} className="text-[15px] leading-[1.68]">
            <TextBlock text={b.text} streaming={!!item.streaming && i === item.blocks.length - 1} />
          </div>
        ) : (
          <Thinking key={i} text={b.text} open={!!item.streaming} />
        )
      )}
      {item.streaming && <span className="h-4 w-[2px] animate-pulse bg-accent" />}
      </div>
    </article>
  );
});

function Thinking({ text, open }: { text: string; open: boolean }) {
  return (
    <details className="conversation-thinking text-[13px] text-dim" open={open}>
      <summary className="cursor-pointer select-none py-1 font-medium">Thought process</summary>
      <div className="max-h-64 overflow-y-auto whitespace-pre-wrap border-l border-line py-1 pl-3 leading-relaxed">
        {text}
      </div>
    </details>
  );
}

export const SystemLine = memo(function SystemLine({ text }: { text: string }) {
  return <p className="my-4 border-l-2 border-line py-1 pl-3 text-[13px] text-dim">{text}</p>;
});

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

function argSummary(name: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  if (name === "bash") return args.command ?? "";
  if (args.path) return args.path;
  if (args.pattern) return args.pattern;
  try {
    return Object.values(args)
      .filter((v) => typeof v === "string")
      .slice(0, 2)
      .join(" ")
      .slice(0, 140);
  } catch {
    return "";
  }
}

export const ToolCard = memo(function ToolCard({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const [fullOutput, setFullOutput] = useState<string | null>(null);

  useEffect(() => {
    if (item.status === "running" || item.status === "error") setOpen(true);
  }, [item.status]);

  const patch = item.details?.patch ?? item.details?.diff;
  const hasPatch = typeof patch === "string" && patch.trim().length > 0;

  return (
    <div className={`conversation-tool ${item.status === "running" ? "is-running" : item.status === "error" ? "is-error" : ""}`}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 py-1.5 text-left">
        <ToolStatusDot status={item.status} />
        <span className="shrink-0 text-dim">
          <ToolGlyph name={item.name} size={12} />
        </span>
        <span className="text-[13px] font-medium">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-dim">
          {argSummary(item.name, item.args)}
        </span>
        <span className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`}>
          <ChevronIcon size={10} />
        </span>
      </button>
      {open && (
        <div className="ml-5 mt-1 border-l border-line pl-3">
          {hasPatch ? (
            <DiffView patch={patch} />
          ) : (
            <>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[13px] leading-relaxed">
                {fullOutput ?? item.output ?? (item.status === "running" ? "running…" : "(no output)")}
              </pre>
              {item.truncated && fullOutput == null ? (
                <button
                  onClick={() => {
                    bridge
                      .getToolOutput(item.toolCallId)
                      .then((result) => setFullOutput(result.content))
                      .catch(() => undefined);
                  }}
                  className="context-button mt-1"
                >
                  Show full output
                </button>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
});

function ToolStatusDot({ status }: { status: string }) {
  if (status === "running") {
    return (
      <span className="spinner inline-block h-3 w-3 rounded-full border-[1.5px] border-line border-t-accent" />
    );
  }
  const color = status === "error" ? "bg-err" : status === "done" ? "bg-ok" : "bg-dim";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

// ---------------------------------------------------------------------------
// Diffs (edit tool `details.patch`/`details.diff`)
// Colors mirror T3 Code's diff palette.
// ---------------------------------------------------------------------------

export const DiffView = memo(function DiffView({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <div className="max-h-72 overflow-auto py-1 font-mono text-[13px] leading-[1.6]">
      {lines.map((l, i) => {
        let cls = "px-3";
        if (l.startsWith("+++") || l.startsWith("---")) cls += " font-semibold text-dim";
        else if (l.startsWith("@@")) cls += " bg-accent-soft text-accent";
        else if (l.startsWith("+")) cls += " bg-[var(--diff-add-bg)] text-[var(--diff-add-fg)]";
        else if (l.startsWith("-")) cls += " bg-[var(--diff-del-bg)] text-[var(--diff-del-fg)]";
        else cls += " text-dim";
        return (
          <div key={i} className={cls}>
            {l || " "}
          </div>
        );
      })}
    </div>
  );
});
