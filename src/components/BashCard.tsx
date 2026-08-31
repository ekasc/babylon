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
  const hasPatch = typeof item.details?.patch === "string" && item.details.patch.trim().length > 0;
  const patch = item.details?.patch ?? item.details?.diff;
  const isRunning = item.status === "running" || b.status === "running";

  useEffect(() => {
    if (isRunning) setOpen(true);
  }, [isRunning]);

  const fetchFull = () => {
    if (fullOutput != null) return;
    bridge
      .getToolOutput(item.toolCallId)
      .then((r) => setFullOutput(r.content))
      .catch(() => undefined);
  };

  return (
    <div className="bash-card-t3 group my-2 overflow-hidden rounded-lg border border-line bg-[var(--raised)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--inset)]"
        aria-expanded={open}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isRunning ? "animate-pulse bg-[var(--accent)]" : item.status === "error" ? "bg-[var(--err)]" : "bg-[var(--dim)]"}`} />
        <span className="font-mono text-[12.5px] text-dim">$</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{truncatedCmd}</span>
        <span className="shrink-0 text-[11px] text-dim">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="border-t border-line bg-[var(--inset)]">
          <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12.5px] leading-5 text-fg">
            <span className="text-dim">$ {command}</span>
            {hasOutput ? "\n" + output : hasPatch ? "" : "\n(no output)"}
          </pre>
          {hasPatch ? <DiffView patch={patch} /> : null}
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
