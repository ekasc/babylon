import { memo, useEffect, useState } from "react";
import type { ChatItem } from "../store";
import { bridge, type HistoryTurn } from "../bridge";
import CodeBlock from "./CodeBlock";
import Markdown from "./Markdown";
import BashCard from "./BashCard";

export const UserMessage = memo(function UserMessage({ item, historyTurn, rollbackDisabled, onRollback }: { item: Extract<ChatItem, { kind: "user" }>; historyTurn?: HistoryTurn; rollbackDisabled?: boolean; onRollback?(entryId: string): void }) {
  return (
    <article className={`conversation-user group/user relative ${item.optimistic ? "conversation-user-sent" : ""}`}>
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
  const lastTextIdx = (() => {
    for (let i = item.blocks.length - 1; i >= 0; i--) if (item.blocks[i].type === "text" && item.blocks[i].text.trim()) return i;
    return -1;
  })();
  const hasPreceding = lastTextIdx > 0 && item.blocks.slice(0, lastTextIdx).some((b) => b.type === "thinking" || b.text.trim());
  return (
    <article className="conversation-assistant">
      <div className="flex flex-col gap-3">
      {item.blocks.map((b, i) => {
        const isLastText = i === lastTextIdx;
        const showDivider = isLastText && hasPreceding && !item.streaming;
        return b.type === "text" ? (
          <div key={i} className="text-[15px] leading-[1.68]">
            {showDivider ? <hr className="assistant-divider" /> : null}
            <TextBlock text={b.text} streaming={!!item.streaming && i === item.blocks.length - 1} />
          </div>
        ) : (
          <Thinking key={i} text={b.text} open={!!item.streaming} />
        );
      })}
      {item.streaming && <span className="h-4 w-[2px] animate-pulse bg-accent" />}
      </div>
    </article>
  );
});

function Thinking({ text, open }: { text: string; open: boolean }) {
  const [expanded, setExpanded] = useState(open);
  useEffect(() => {
    if (open) setExpanded(true);
  }, [open]);
  const isStreaming = open;
  return (
    <details className={`thinking-card ${expanded ? "is-open" : ""} ${isStreaming ? "is-streaming" : ""}`} open={expanded} onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}>
      <summary className="thinking-summary">
        <span className={`thinking-dot ${isStreaming ? "is-pulse" : ""}`} aria-hidden="true" />
        <span className="thinking-label">{isStreaming ? "Thinking..." : "Thought"}</span>
        <span className="thinking-hint">{isStreaming ? "streaming" : expanded ? "collapse" : "expand"}</span>
      </summary>
      <div className="thinking-body">
        <div className="thinking-content">{text}</div>
      </div>
    </details>
  );
}

export const SystemLine = memo(function SystemLine({ text }: { text: string }) {
  return <p className="conversation-system-in my-4 border-l-2 border-line py-1 pl-3 text-[13px] text-dim">{text}</p>;
});

/** Distinct launch card for a model-spawned subagent / thread / workflow.
 *  Card-style, not a text line — stands out in the transcript and invites click to Activity. */
export const LaunchCard = memo(function LaunchCard({ item, onOpen }: { item: Extract<ChatItem, { kind: "launch" }>; onOpen?(runId: string, runKind: "subagent" | "thread" | "workflow"): void }) {
  const { runKind, label, status, runId } = item;
  const isRunning = status === "running";
  const dot = isRunning ? "bg-accent animate-pulse" : status === "completed" ? "bg-ok" : status === "failed" ? "bg-err" : "bg-dim";
  const verb = isRunning ? "Running" : status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Stopped";
  const iconBg = isRunning ? "bg-accent text-white" : status === "completed" ? "bg-ok text-white" : status === "failed" ? "bg-err text-white" : "bg-inset text-dim";
  const border = isRunning ? "border-accent/30" : status === "failed" ? "border-err/25" : "border-line";
  return (
    <button
      type="button"
      onClick={() => onOpen?.(runId, runKind)}
      title={`Open ${runKind} ${runId} in Activity — click to view`}
      className={`conversation-launch my-3 flex w-full items-center gap-3 rounded-xl border ${border} bg-inset/60 px-3.5 py-2.5 text-left shadow-sm backdrop-blur-sm transition-all duration-150 hover:bg-inset hover:shadow-md hover:border-accent/20 active:scale-[0.99]`}
    >
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold leading-none ${iconBg}`} aria-hidden="true">
        {runKind === "subagent" ? "◈" : runKind === "thread" ? "⬢" : "⬣"}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-semibold capitalize tracking-tight text-fg">{runKind}</span>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-wide ${isRunning ? "bg-accent-soft text-accent" : status === "completed" ? "bg-ok/10 text-ok" : status === "failed" ? "bg-err/10 text-err" : "bg-inset text-dim"}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
            {verb}
          </span>
        </span>
        <span className="truncate font-mono text-[12.5px] leading-none text-dim" title={label}>{label}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-accent">
        Open <span className="text-[10px]">↗</span>
      </span>
    </button>
  );
});

/** Auto-recap annotation: a distinct, slightly raised card so a summary is
 *  easy to spot in a long transcript without leaving the instrument register. */
export const RecapLine = memo(function RecapLine({ text }: { text: string }) {
  return (
    <div className="conversation-system-in my-5 rounded-lg border border-line bg-inset/60 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">Recap</p>
      <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-6">{text}</p>
    </div>
  );
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

/** Compact preview shown under a collapsed edit tool: hunk headers plus the
 *  first few changed lines, so an edit is visible without expanding. */
export function miniPatch(patch: string, maxLines = 6): string {
  const out: string[] = [];
  let shown = 0;
  let skipped = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      out.push(line);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      if (shown < maxLines) {
        out.push(line);
        shown++;
      } else {
        skipped++;
      }
    }
  }
  if (skipped > 0) out.push(`… ${skipped} more changed line${skipped === 1 ? "" : "s"} — expand for full diff`);
  return out.join("\n");
}

export const ToolCard = memo(function ToolCard({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const [fullOutput, setFullOutput] = useState<string | null>(null);

  useEffect(() => {
    if (item.status === "running" || item.status === "error") setOpen(true);
  }, [item.status]);

  const patch = item.details?.patch ?? item.details?.diff;
  const hasPatch = typeof patch === "string" && patch.trim().length > 0;
  const summary = argSummary(item.name, item.args);

  // Babylon wraps the bash tool with a richer metadata payload (command argv,
  // exit code, signal, duration, hints). Surface it via BashCard so the chat
  // shows the actual command chip, not just "bash".
  if (item.name === "bash" && item.babylon?.kind === "babylon_bash") {
    return <BashCard item={item as Extract<typeof item, { babylon: { kind: "babylon_bash" } }>} />;
  }

  return (
    <div className={`tool-row ${item.status === "running" ? "is-running" : item.status === "error" ? "is-error" : ""}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="tool-row-header"
        aria-expanded={open}
      >
        <span className={`tool-name ${item.status === "done" ? "is-ok" : item.status === "error" ? "is-err" : ""}`}>{item.name}</span>
        <span className="tool-summary">{summary || <span className="text-dim">—</span>}</span>
        {item.status === "running" ? <span className="tool-status">running</span> : null}
      </button>
      {!open && hasPatch ? (
        <div className="tool-preview">
          <DiffView patch={miniPatch(patch)} />
        </div>
      ) : null}
      {open ? (
        <div className="tool-body">
          {hasPatch ? (
            <DiffView patch={patch} />
          ) : (
            <>
              <pre className="tool-output">
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
      ) : null}
    </div>
  );
});

/** Collapses a run of consecutive tool calls into one summary row. */
export const ToolGroup = memo(function ToolGroup({ tools }: { tools: Array<Extract<ChatItem, { kind: "tool" }>> }) {
  const [open, setOpen] = useState(false);
  const anyRunning = tools.some((t) => t.status === "running" || t.status === "pending");
  const anyError = tools.some((t) => t.status === "error");
  const aggregate: "running" | "error" | "done" = anyRunning ? "running" : anyError ? "error" : "done";

  return (
    <div className="tool-group">
      <button
        onClick={() => setOpen((o) => !o)}
        className="tool-group-header"
        aria-expanded={open}
      >
        <span className={`tool-name ${aggregate === "done" ? "is-ok" : aggregate === "error" ? "is-err" : ""}`}>{tools.length} tool calls</span>
        <span className="tool-summary text-dim">click to {open ? "collapse" : "expand"}</span>
      </button>
      {open ? (
        <div className="tool-group-list">
          {tools.map((t) => (
            <ToolCard key={t.key} item={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Diffs (edit tool `details.patch`/`details.diff`)
// Colors mirror T3 Code's diff palette.
// ---------------------------------------------------------------------------

export const DiffView = memo(function DiffView({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <div className="tool-diff">
      {lines.map((l, i) => {
        let cls = "tool-diff-line";
        if (l.startsWith("+++") || l.startsWith("---")) cls += " is-hunk";
        else if (l.startsWith("@@")) cls += " is-meta";
        else if (l.startsWith("+")) cls += " is-add";
        else if (l.startsWith("-")) cls += " is-del";
        return (
          <div key={i} className={cls}>
            {l || " "}
          </div>
        );
      })}
    </div>
  );
});
