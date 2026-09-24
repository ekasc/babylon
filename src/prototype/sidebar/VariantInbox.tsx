import { useState } from "react";
import { SESSIONS, projectColor, relTime, statusColor, statusLabel, type Session } from "./mock";

function Section({ title, hint, rows }: { title: string; hint?: string; rows: Session[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="mb-3">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">{title}</span>
        <span className="font-mono text-[10px] text-dim">{hint ?? rows.length}</span>
      </div>
      {rows.map((s) => (
        <button key={s.id} className="group flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-inset">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor(s.exec, s.unread) }} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] leading-tight">{s.title}</span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-dim">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: projectColor(s.project) }} />
              <span className="truncate">{s.project}</span>
              <span>·</span>
              <span style={{ color: statusColor(s.exec, s.unread) }}>{statusLabel(s.exec, s.unread)}</span>
              {s.agents ? <span>· {s.agents} agent{s.agents > 1 ? "s" : ""}</span> : null}
            </span>
          </span>
          <span className="mt-0.5 shrink-0 font-mono text-[10px] text-dim">{relTime(s.minutesAgo)}</span>
        </button>
      ))}
    </section>
  );
}

/** B — Inbox: state-first triage. No project tree; sections by what needs the user. */
export function VariantInbox() {
  const [onlyUnread, setOnlyUnread] = useState(false);

  const open = SESSIONS.filter((s) => !s.settled && (!onlyUnread || s.unread || s.exec !== "idle"));
  const needs = open.filter((s) => s.exec === "approval" || s.unread);
  const running = open.filter((s) => (s.exec === "working" || s.exec === "waiting") && !needs.includes(s));
  const rest = open.filter((s) => !needs.includes(s) && !running.includes(s));

  return (
    <div className="flex h-full w-[300px] flex-col border-r border-line bg-bg">
      <header className="px-3 pb-2 pt-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-[15px] font-semibold">Inbox</h1>
          <span className="font-mono text-[10px] text-dim">{needs.length} need you</span>
        </div>
        <div className="mt-2 flex gap-1">
          {(["All", "Unread"] as const).map((label) => {
            const on = (label === "Unread") === onlyUnread;
            return (
              <button
                key={label}
                onClick={() => setOnlyUnread(label === "Unread")}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] ${on ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-dim hover:text-fg"}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto pt-1">
        <Section title="Needs you" hint={`${needs.length}`} rows={needs} />
        <Section title="Running" rows={running} />
        <Section title="Recent" rows={rest} />
      </div>
    </div>
  );
}
