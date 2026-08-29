import { memo, useEffect, useState } from "react";
import type { ChatItem } from "../store";
import { bridge } from "../bridge";
import { DiffView, miniPatch } from "./items";

type BashBabylon = Extract<NonNullable<Extract<ChatItem, { kind: "tool" }>["babylon"]>, { kind: "babylon_bash" }>;
type BashItem = Extract<ChatItem, { kind: "tool" }> & { babylon: BashBabylon };

interface BashCardProps {
  item: BashItem;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  running: { label: "running", tone: "is-running" },
  completed: { label: "exit 0", tone: "is-ok" },
  exited: { label: "exit 0", tone: "is-ok" },
  signaled: { label: "signaled", tone: "is-err" },
  failed: { label: "failed", tone: "is-err" },
  timeout: { label: "timeout", tone: "is-warn" },
  aborted: { label: "aborted", tone: "is-warn" },
};

export default memo(function BashCard({ item }: BashCardProps) {
  const [open, setOpen] = useState(false);
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const b = item.babylon;
  const argv = b.argv ?? [];
  const exitCode = b.exitCode;
  const duration = b.durationMs;
  const status = b.status ?? item.status;
  const label = STATUS_LABEL[status] ?? { label: status, tone: "is-dim" };
  const argvTail = argv.slice(1, 9).join(" ");
  const hasMoreArgs = argv.length > 10;
  const patch = item.details?.patch ?? item.details?.diff;
  const hasPatch = typeof patch === "string" && patch.trim().length > 0;

  useEffect(() => {
    if (item.status === "running" || item.status === "error") setOpen(true);
  }, [item.status]);

  const fetchFull = () => {
    if (fullOutput != null) return;
    bridge
      .getToolOutput(item.toolCallId)
      .then((result) => setFullOutput(result.content))
      .catch(() => undefined);
  };

  return (
    <div className={`bash-card tool-row ${label.tone} ${item.status === "running" ? "is-running" : item.status === "error" ? "is-error" : ""}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="bash-header"
        aria-expanded={open}
      >
        <span className="bash-prompt" aria-hidden="true">$</span>
        <span className={`bash-head ${exitCode === 0 ? "is-ok" : exitCode !== undefined ? "is-err" : status === "failed" || status === "exited" && exitCode !== 0 ? "is-err" : ""}`}>{b.headBase || b.head || "bash"}</span>
        {argvTail ? <span className="bash-tail">{argvTail}{hasMoreArgs ? " …" : ""}</span> : null}
        <span className="bash-spacer" />
        {b.cwd ? <span className="bash-cwd" title={b.cwd}>{b.cwd}</span> : null}
        {duration != null ? <span className="bash-duration">{formatDuration(duration)}</span> : null}
        {exitCode !== undefined ? <span className={`bash-exit ${exitCode === 0 ? "is-ok" : "is-err"}`}>{exitCode === 0 ? "exit 0" : `exit ${exitCode}`}</span> : null}
        {b.exitSignal ? <span className="bash-exit is-err">{b.exitSignal}</span> : null}
        {status === "running" ? <span className="tool-status">running</span> : null}
      </button>
      {b.unsafe ? (
        <div className="bash-unsafe" role="alert">
          <strong>Potentially unsafe</strong>
          <span>{b.unsafe}</span>
        </div>
      ) : null}
      {!open && hasPatch ? (
        <div className="tool-preview">
          <DiffView patch={miniPatch(patch)} />
        </div>
      ) : null}
      {open ? (
        <div className="bash-body">
          <pre className="bash-command" aria-label="Command">{b.command}</pre>
          {b.argv.length > 1 ? (
            <pre className="bash-argv" aria-label="Argument vector">{(b.argv as string[]).map((arg: string) => JSON.stringify(arg)).join(" ")}</pre>
          ) : null}
          {b.hints.length > 0 ? (
            <div className="bash-hints" role="note">
              {b.hints.map((h: { kind: "explain"; label: string; description: string }, i: number) => (
                <span key={i} className="bash-hint" title={h.description}>
                  <span className="bash-hint-label">{h.label}</span>
                  <span className="bash-hint-desc">{h.description}</span>
                </span>
              ))}
            </div>
          ) : null}
          {hasPatch ? (
            <DiffView patch={patch} />
          ) : (
            <>
              <pre className="tool-output">
                {fullOutput ?? item.output ?? (item.status === "running" ? "running…" : "(no output)")}
              </pre>
              {item.truncated && fullOutput == null ? (
                <button onClick={fetchFull} className="context-button mt-1">
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
