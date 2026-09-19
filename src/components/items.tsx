import { memo, useEffect, useRef, useState } from "react";
import type { ChatItem } from "../store";
import { bridge, type HistoryTurn } from "../bridge";
import { parseSkillRef } from "../lib/skillRef";
import Markdown from "./Markdown";
import BashCard from "./BashCard";

export const UserMessage = memo(function UserMessage({ item, historyTurn, rollbackDisabled, onRollback }: { item: Extract<ChatItem, { kind: "user" }>; historyTurn?: HistoryTurn; rollbackDisabled?: boolean; onRollback?(entryId: string): void }) {
  const skillRef = parseSkillRef(item.text);
  const afterChip = skillRef ? item.text.replace(/^\/skill:[a-z0-9-]+/, "").trimStart() : "";
  const [expandSkill, setExpandSkill] = useState(false);
  return (
    <article className={`conversation-user group/user relative ${item.optimistic ? "conversation-user-sent" : ""}`}>
      <div className="whitespace-pre-wrap text-[length:var(--chat-r-15)] leading-[1.55]">
      {item.images && item.images.length > 0 && (
        <span className="mb-3 flex flex-wrap gap-2">
          {item.images.map((src, i) => (
            <img
              key={i}
              src={src}
              alt={`Attached image ${i + 1}`}
              loading="lazy"
              decoding="async"
              className="max-h-48 max-w-[260px] rounded-lg border border-line object-contain"
            />
          ))}
        </span>
      )}
      {skillRef ? (
        <span className="inline-flex flex-col gap-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-inset px-2.5 py-1 text-[11px] leading-none text-dim">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            /skill:{skillRef.name}
          </span>
          {skillRef.full ? (
            <>
              <button onClick={() => setExpandSkill((v) => !v)} className="self-start rounded-full px-1.5 py-0.5 text-[length:var(--chat-r-11)] text-dim hover:bg-line hover:text-fg">{expandSkill ? "hide" : "show"} SKILL.md</button>
              {expandSkill ? <span className="block max-h-64 overflow-auto rounded-lg border border-line bg-inset/50 px-3 py-2 font-mono text-[length:var(--code-font)] leading-[1.55]">{item.text}</span> : null}
            </>
          ) : afterChip ? (
            <span className="whitespace-pre-wrap text-[length:var(--chat-r-15)] leading-[1.55]">{afterChip}</span>
          ) : null}
        </span>
      ) : item.text}
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

export const AssistantMessage = memo(function AssistantMessage({ item, hideThinking = false }: { item: Extract<ChatItem, { kind: "assistant" }>; hideThinking?: boolean }) {
  const blocks = hideThinking ? item.blocks.filter((b) => b.type === "text") : item.blocks;
  // Non-streaming holds every delta back until message_end, so the article
  // would otherwise sit visually empty for the whole run. Show an explicit,
  // announced in-flight row instead of a bare aria-hidden caret.
  const inFlight = !!item.streaming && item.blocks.length === 0;
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!item.streaming) {
      startedAt.current = null;
      return;
    }
    if (startedAt.current == null) startedAt.current = Date.now();
    const tick = () => setElapsed(Math.floor((Date.now() - (startedAt.current as number)) / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [item.streaming]);
  const lastTextIdx = (() => {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].type === "text" && blocks[i].text.trim()) return i;
    return -1;
  })();
  const hasPreceding = lastTextIdx > 0 && blocks.slice(0, lastTextIdx).some((b) => b.type === "thinking" || b.text.trim());
  return (
    <article className="conversation-assistant" aria-busy={inFlight || undefined}>
      <div className="flex flex-col gap-3">
      {!!item.streaming ? (
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-[12px] text-dim">
          <span className="thinking-dot is-pulse" aria-hidden />
          <span>Working{elapsed > 0 ? ` · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}` : "…"}</span>
        </div>
      ) : null}
      {blocks.map((b, i) => {
        const isLastText = i === lastTextIdx;
        const showDivider = isLastText && hasPreceding && !item.streaming;
        return b.type === "text" ? (
          <div key={i} className="text-[length:var(--chat-r-15)] leading-[1.68]">
            {showDivider ? <hr className="assistant-divider" /> : null}
            <TextBlock text={b.text} streaming={!!item.streaming && i === item.blocks.length - 1} />
          </div>
        ) : (
          <Thinking key={i} text={b.text} streaming={!!item.streaming} />
        );
      })}
      {inFlight ? null : item.streaming ? (
        <span aria-hidden="true" className="h-4 w-[2px] animate-pulse bg-accent" />
      ) : null}
      </div>
    </article>
  );
});

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  // Reasoning renders as a single collapsed line by default and never
  // auto-expands; the full text is one click away. `streaming` only drives
  // the live pulse, so a run's rationale is always discoverable without
  // swallowing the transcript.
  const [expanded, setExpanded] = useState(false);
  const isStreaming = streaming;
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  const label = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
  // The header already shows the first line: the expanded body continues
  // after it instead of repeating it. Single-line reasoning falls back to
  // the full text so the body is never empty.
  const lines = text.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim());
  const afterFirst = firstIdx >= 0 ? lines.slice(firstIdx + 1).join("\n").replace(/^\s+/, "") : "";
  const bodyText = afterFirst ? afterFirst : text;
  return (
    <details
      className={`thinking-card ${expanded ? "is-open" : "is-collapsed"} ${isStreaming ? "is-streaming" : ""}`}
      open={expanded}
      onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}
    >
      <summary className="thinking-summary">
        <span className={`thinking-dot ${isStreaming ? "is-pulse" : ""}`} aria-hidden />
        <span className="thinking-label">// {label || (isStreaming ? "thinking…" : "thought")}</span>
        <span className="thinking-hint">{isStreaming ? "Streaming" : expanded ? "Hide" : "Show"}</span>
      </summary>
      <div className="thinking-body">
        <div className="thinking-content">{bodyText}</div>
      </div>
    </details>
  );
}

export const SystemLine = memo(function SystemLine({ text }: { text: string }) {
  return <p className="conversation-system-in my-4 rounded-md border border-line bg-inset/50 px-3 py-1.5 text-[length:var(--chat-r-13)] text-dim">{text}</p>;
});

/** Distinct launch card for a model-spawned subagent / thread / workflow.
 *  Card-style, not a text line, stands out in the transcript and invites click to Activity. */
export const LaunchCard = memo(function LaunchCard({ item, onOpen, onControl }: { item: Extract<ChatItem, { kind: "launch" }>; onOpen?(runId: string, runKind: "subagent" | "thread" | "workflow"): void; onControl?(runId: string, runKind: "subagent" | "thread" | "workflow", action: "stop"): void }) {
  const { runKind, label, status, runId, log } = item;
  const isRunning = status === "running";
  const dot = isRunning ? "bg-accent animate-pulse" : status === "completed" ? "bg-ok" : status === "failed" ? "bg-err" : "bg-dim";
  const verb = isRunning ? "Running" : status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Stopped";
  const iconBg = isRunning ? "bg-fg text-bg" : status === "completed" ? "bg-ok/15 text-ok" : status === "failed" ? "bg-err/15 text-err" : "bg-inset text-dim";
  const border = isRunning ? "border-accent/30" : status === "failed" ? "border-err/25" : "border-line";
  return (
    <div
      className={`conversation-launch my-3 flex w-full items-center gap-3 rounded-lg border ${border} bg-inset/60 px-3.5 py-2.5 transition-colors duration-150 hover:bg-inset hover:border-line-strong ${isRunning ? "is-running" : ""}`}
    >
      <button
        type="button"
        onClick={() => onOpen?.(runId, runKind)}
        title={`Open ${runKind} ${runId} in Activity, click to view`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center" aria-hidden="true">
          <span className={`grid h-7 w-7 place-items-center rounded-full text-[length:var(--chat-r-11)] font-bold leading-none ${iconBg}`}>
            {runKind === "subagent" ? "◈" : runKind === "thread" ? "⬢" : "⬣"}
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
          <span className="flex items-center gap-2">
            <span className="text-[12px] font-semibold capitalize tracking-tight text-fg">{runKind}</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[length:var(--chat-r-11)] font-semibold tracking-wide ${isRunning ? "bg-accent-soft text-accent" : status === "completed" ? "bg-ok/10 text-ok" : status === "failed" ? "bg-err/10 text-err" : "bg-inset text-dim"}`}>
              {isRunning ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden="true" /> : <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />}
              {verb}
            </span>
          </span>
          <span className="truncate text-[11px] leading-snug text-dim" title={label}>{label}</span>
          {log ? (
            <span className="truncate font-mono text-[length:var(--chat-r-11)] leading-snug text-dim" title={log}>{log}</span>
          ) : null}
        </span>
      </button>
      {isRunning ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onControl?.(runId, runKind, "stop"); }}
          title={`Stop ${runKind}`}
          className="flex shrink-0 items-center gap-1 rounded-md border border-err/30 bg-err/10 px-2 py-1 text-[length:var(--chat-r-11)] font-semibold text-err transition-colors hover:bg-err/20"
        >
          <span aria-hidden className="text-[length:var(--chat-r-10)] leading-none">■</span> Stop
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => onOpen?.(runId, runKind)}
        title={`Open ${runKind} ${runId} in Activity`}
        className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-accent"
      >
        Open <span aria-hidden="true" className="text-[length:var(--chat-r-10)]">↗</span>
      </button>
    </div>
  );
});

/** Auto-recap annotation: a distinct, slightly raised card so a summary is
 *  easy to spot in a long transcript without leaving the instrument register. */
export const RecapLine = memo(function RecapLine({ text }: { text: string }) {
  return (
    <div className="conversation-system-in my-4 rounded-md border border-line bg-inset/60 px-4 py-3">
      <p className="text-[length:var(--chat-r-11)] font-semibold uppercase tracking-wider text-accent">Recap</p>
      <p className="mt-1.5 whitespace-pre-wrap text-[length:var(--chat-r-14)] leading-[1.55]">{text}</p>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

function argSummary(name: string, args: Record<string, unknown> | null | undefined): string {
  if (!args || typeof args !== "object") return "";
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (name === "bash") return str(args.command);
  if (args.path) return str(args.path);
  if (args.pattern) return str(args.pattern);
  try {
    return Object.values(args)
      .filter((v): v is string => typeof v === "string")
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
  if (skipped > 0) out.push(`… ${skipped} more changed line${skipped === 1 ? "" : "s"}, expand for full diff`);
  return out.join("\n");
}

export const ToolCard = memo(function ToolCard({ item, onDisclosureToggle }: { item: Extract<ChatItem, { kind: "tool" }>; onDisclosureToggle?: () => void }) {
  const [open, setOpen] = useState(false);
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [outputLoading, setOutputLoading] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);

  useEffect(() => {
    // Expanded only for failures; a run in progress never force-opens a card.
    if (item.status === "error") setOpen(true);
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
        onClick={() => { onDisclosureToggle?.(); setOpen((o) => !o); }}
        className="tool-row-header"
        aria-expanded={open}
      >
        <span className={`tool-dot ${item.status === "running" ? "running" : item.status === "done" ? "done" : item.status === "error" ? "error" : ""}`} aria-hidden />
        <span className={`tool-name ${item.status === "done" ? "is-ok" : item.status === "error" ? "is-err" : ""}`}>{item.name}</span>
        <span className="tool-summary" title={summary || undefined}>{summary || <span className="text-dim">-</span>}</span>
        {item.status === "running" ? <span className="tool-status">Running</span> : null}
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
                <>
                  <button
                    onClick={() => {
                      setOutputLoading(true);
                      setOutputError(null);
                      bridge
                        .getToolOutput(item.toolCallId)
                        .then((result) => setFullOutput(result.content))
                        .catch((e) => setOutputError(e instanceof Error ? e.message : "couldn't load full output"))
                        .finally(() => setOutputLoading(false));
                    }}
                    disabled={outputLoading}
                    className="context-button mt-1 disabled:opacity-50"
                  >
                    {outputLoading ? "Loading full output…" : "Show full output"}
                  </button>
                  {outputError ? <p role="alert" className="mt-1 text-[12px] text-err">{outputError}</p> : null}
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
});

/** Collapses a run of consecutive tool calls into one summary row. */
export const ToolGroup = memo(function ToolGroup({ tools, onDisclosureToggle }: { tools: Array<Extract<ChatItem, { kind: "tool" }>>; onDisclosureToggle?: () => void }) {
  const [open, setOpen] = useState(false);
  const anyRunning = tools.some((t) => t.status === "running" || t.status === "pending");
  const anyError = tools.some((t) => t.status === "error");
  const aggregate: "running" | "error" | "done" = anyRunning ? "running" : anyError ? "error" : "done";

  return (
    <div className="tool-group">
      <button
        onClick={() => { onDisclosureToggle?.(); setOpen((o) => !o); }}
        className="tool-group-header"
        aria-expanded={open}
      >
        <span className={`tool-dot ${aggregate === "running" ? "running" : aggregate === "error" ? "error" : "done"}`} aria-hidden />
        <span className={`tool-name ${aggregate === "done" ? "is-ok" : aggregate === "error" ? "is-err" : ""}`}>{tools.length} tool calls</span>
        <span className="tool-summary text-dim">{open ? "Collapse" : "Expand"}</span>
      </button>
      {open ? (
        <div className="tool-group-list">
          {tools.map((t) => (
            <ToolCard key={t.key} item={t} onDisclosureToggle={onDisclosureToggle} />
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
