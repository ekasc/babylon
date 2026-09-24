import { memo, useEffect, useRef, useState } from "react";
import type { ChatItem } from "../store";
import { bridge, type HistoryTurn } from "../bridge";
import { parseSkillRef, skillDisplayBody } from "../lib/skillRef";
import Markdown from "./Markdown";
import BashCard from "./BashCard";
import { CheckIcon, CopyIcon } from "./icons";
import DesignReviewCard, { isDesignReviewDetails } from "./DesignReviewCard";

/** Hover-reveal icon button copying an assistant reply (text blocks only,
 *  never reasoning). Mirrors CodeBlock's copied feedback. */
export const CopyMessageButton = memo(function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1200);
          },
          () => undefined
        );
      }}
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy message"}
      className="grid h-7 w-7 place-items-center rounded-md text-dim hover:bg-inset hover:text-fg"
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
    </button>
  );
});

export const UserMessage = memo(function UserMessage({ item, historyTurn, rollbackDisabled, onRollback, hideActions }: { item: Extract<ChatItem, { kind: "user" }>; historyTurn?: HistoryTurn; rollbackDisabled?: boolean; onRollback?(entryId: string): void; /** Hide the floating actions when the turn's fold row owns Rollback instead. */ hideActions?: boolean }) {
  const skillRef = parseSkillRef(item.text);
  const afterChip = skillRef?.args ?? (skillRef ? item.text.replace(/^\/skill:[a-z0-9-]+/, "").trimStart() : "");
  const [expandSkill, setExpandSkill] = useState(false);
  return (
    <article className={`conversation-user group/user relative ${item.optimistic ? "conversation-user-sent" : ""}`}>
      <div className="whitespace-pre-wrap text-[length:var(--chat-r-15)] leading-[1.55] select-text">
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
          <code className="code-pill">/skill:{skillRef.name}</code>
          {skillRef.full ? (
            <>
              {skillRef.args ? (
                <span className="whitespace-pre-wrap text-[length:var(--chat-r-15)] leading-[1.55]">{skillRef.args}</span>
              ) : null}
              <button onClick={() => setExpandSkill((v) => !v)} className="self-start rounded-full px-1.5 py-0.5 text-[length:var(--chat-r-11)] text-dim hover:bg-line hover:text-fg">{expandSkill ? "hide" : "show"} SKILL.md</button>
              {expandSkill ? <span className="block max-h-64 overflow-auto rounded-lg border border-line bg-inset/50 px-3 py-2 font-mono text-[length:var(--code-font)] leading-[1.55]">{skillDisplayBody(item.text)}</span> : null}
            </>
          ) : afterChip ? (
            <span className="whitespace-pre-wrap text-[length:var(--chat-r-15)] leading-[1.55]">{afterChip}</span>
          ) : null}
        </span>
      ) : item.text}
      </div>
      {item.entryId && historyTurn && !hideActions ? (
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
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b !== undefined && b.type === "text" && b.text.trim()) return i;
    }
    return -1;
  })();
  const hasPreceding = lastTextIdx > 0 && blocks.slice(0, lastTextIdx).some((b) => b.type === "thinking" || b.text.trim());
  const replyText = blocks
    .flatMap((b) => (b !== undefined && b.type === "text" && b.text.trim() ? [b.text.trim()] : []))
    .join("\n\n");
  return (
    <article className="conversation-assistant group" aria-busy={inFlight || undefined}>
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
          <div key={i} className="text-[length:var(--chat-r-15)] leading-[1.68] select-text">
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
      {!item.streaming && replyText ? (
        <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyMessageButton text={replyText} />
        </div>
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
  return (
    <details
      className={`thinking-card ${expanded ? "is-open" : "is-collapsed"} ${isStreaming ? "is-streaming" : ""}`}
      open={expanded}
      onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}
    >
      <summary className="thinking-summary">
        <span className={`thinking-dot ${isStreaming ? "is-pulse" : ""}`} aria-hidden />
        <span className="thinking-label">{isStreaming ? "thinking…" : "thought"}</span>
        <span className="thinking-hint">{isStreaming ? "Streaming" : expanded ? "Hide" : "Show"}</span>
      </summary>
      <div className="thinking-body">
        <div className="thinking-content select-text">{text}</div>
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
  const { runKind, label, status, runId } = item;
  const isRunning = status === "running";
  const dot = isRunning ? "bg-accent animate-pulse" : status === "completed" ? "bg-ok" : status === "failed" ? "bg-err" : "bg-dim";
  const verb = isRunning ? "Running" : status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Stopped";
  const verbTone = isRunning ? "text-accent" : status === "completed" ? "text-ok" : status === "failed" ? "text-err" : "text-dim";
  // Compact execution row (quiet metadata register): dot + kind + label +
  // state, no bordered card. Detail lives in Activity; Stop/Open stay inline.
  return (
    <div className="conversation-launch my-1 flex w-full items-center gap-2 px-1 text-[12px] text-dim">
      <button
        type="button"
        onClick={() => onOpen?.(runId, runKind)}
        title={`Open ${runKind} ${runId} in Activity`}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-fg"
      >
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <span className="shrink-0 font-medium capitalize">{runKind}</span>
        <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
        <span className={`shrink-0 ${verbTone}`}>{verb}</span>
      </button>
      {isRunning ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onControl?.(runId, runKind, "stop"); }}
          title={`Stop ${runKind}`}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-err hover:bg-err/10"
        >
          Stop
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => onOpen?.(runId, runKind)}
        title={`Open ${runKind} ${runId} in Activity`}
        className="shrink-0 text-[11px] font-medium text-dim hover:text-accent"
      >
        Open <span aria-hidden="true">↗</span>
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

function argSummary(name: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const record = args as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (name === "bash") return str(record.command);
  if (record.path) return str(record.path);
  if (record.pattern) return str(record.pattern);
  try {
    return Object.values(record)
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

/**
 * A design review round is not a tool call the user needs to inspect: it IS
 * the review. Rendering it as the first-class block (screenshots beside the
 * punchlist) happens here, so every transcript path that renders a tool card
 * gets it — the live view and the history window alike.
 */
export const ToolCard = memo(function ToolCard({ item, sessionFile = null, cwd = null, onDisclosureToggle }: { item: Extract<ChatItem, { kind: "tool" }>; sessionFile?: string | null; cwd?: string | null; onDisclosureToggle?: () => void }) {
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
  if (item.name === "design_review" && isDesignReviewDetails(item.details) && item.status !== "running") {
    return <DesignReviewCard details={item.details} cwd={cwd} />;
  }

  if (item.name === "bash" && item.babylon?.kind === "babylon_bash") {
    return <BashCard item={item as Extract<typeof item, { babylon: { kind: "babylon_bash" } }>} sessionFile={sessionFile} />;
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
              <pre className="tool-output select-text">
                {fullOutput ?? item.output ?? (item.status === "running" ? "running…" : "(no output)")}
              </pre>
              {item.truncated && fullOutput == null ? (
                <>
                  <button
                    onClick={() => {
                      if (!sessionFile) return;
                      setOutputLoading(true);
                      setOutputError(null);
                      bridge
                        .getToolOutput(sessionFile, item.toolCallId)
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
export const ToolGroup = memo(function ToolGroup({ tools, sessionFile = null, cwd = null, onDisclosureToggle }: { tools: Array<Extract<ChatItem, { kind: "tool" }>>; sessionFile?: string | null; cwd?: string | null; onDisclosureToggle?: () => void }) {
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
            <ToolCard key={t.key} item={t} sessionFile={sessionFile} cwd={cwd} onDisclosureToggle={onDisclosureToggle} />
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
    <div className="tool-diff select-text">
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
