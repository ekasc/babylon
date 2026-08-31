import { memo, useEffect, useState } from "react";
import type { ChatItem } from "../store";
import { bridge } from "../bridge";
import { DiffView } from "./items";

type BashBabylon = Extract<NonNullable<Extract<ChatItem, { kind: "tool" }>["babylon"]>, { kind: "babylon_bash" }>;
type BashItem = Extract<ChatItem, { kind: "tool" }> & { babylon: BashBabylon };

interface BashCardProps {
  item: BashItem;
}

export default memo(function BashCard({ item }: BashCardProps) {
  const [open, setOpen] = useState(false);
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const b = item.babylon;
  const command = b.command || b.head || "bash";
  const truncatedCmd = command.length > 80 ? command.slice(0, 80) + "…" : command;
  const output = fullOutput ?? item.output ?? "";
  const hasOutput = output.trim().length > 0;
  const patch = item.details?.patch ?? item.details?.diff;
  const hasPatch = typeof patch === "string" && patch.trim().length > 0;
  const isRunning = item.status === "running" || b.status === "running";
  const isError = item.status === "error" || b.status === "failed" || b.status === "signaled" || (b.exitCode !== undefined && b.exitCode !== 0);

  useEffect(() => {
    if (isRunning || isError) setOpen(true);
  }, [isRunning, isError]);

  const formatDuration = (ms?: number) => {
    if (ms == null) return null;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  };

  const fetchFull = () => {
    if (fullOutput != null) return;
    bridge
      .getToolOutput(item.toolCallId)
      .then((r) => setFullOutput(r.content))
      .catch(() => undefined);
  };

  return (
    <div className="bash-card-t3 group my-2 overflow-hidden rounded-lg border border-line bg-[var(--raised)]">
      {b.unsafe ? (
        <div className="flex items-center gap-2 bg-[color-mix(in_srgb,var(--err)_8%,transparent)] px-3 py-1.5 text-[12px] text-[var(--err)]" role="alert">
          <span className="font-semibold uppercase tracking-wide text-[11px]">Potentially unsafe</span>
          <span className="truncate">{b.unsafe}</span>
        </div>
      ) : null}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--inset)]"
        aria-expanded={open}
        title={command}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isRunning ? "animate-pulse bg-[var(--accent)]" : isError ? "bg-[var(--err)]" : "bg-[var(--dim)]"}`} aria-hidden />
        <span className="font-mono text-[12.5px] text-dim">$</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{truncatedCmd}</span>
        {b.durationMs != null ? <span className="shrink-0 font-mono text-[11px] text-dim">{formatDuration(b.durationMs)}</span> : null}
        {b.exitCode !== undefined ? <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] ${b.exitCode === 0 ? "bg-[color-mix(in_srgb,var(--ok)_12%,transparent)] text-[var(--ok)]" : "bg-[color-mix(in_srgb,var(--err)_12%,transparent)] text-[var(--err)]"}`}>{b.exitCode === 0 ? "exit 0" : `exit ${b.exitCode}`}</span> : b.exitSignal ? <span className="shrink-0 rounded bg-[color-mix(in_srgb,var(--err)_12%,transparent)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--err)]">{b.exitSignal}</span> : null}
        <span className="shrink-0 text-[11px] text-dim">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="border-t border-line bg-[var(--inset)]">
          <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12.5px] leading-5 text-fg">
            <span className="text-dim">$ {command}</span>
            {hasOutput ? "\n" + output : hasPatch ? "" : "\n(no output)"}
          </pre>
          {hasPatch ? <div className="max-h-[320px] overflow-auto"><DiffView patch={patch} /></div> : null}
          {item.truncated && fullOutput == null ? (
            <button onClick={fetchFull} className="m-2 rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-dim hover:text-fg">
              Show full output
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
});
