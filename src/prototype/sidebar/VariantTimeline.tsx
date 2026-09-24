import { SESSIONS, PROJECTS, projectColor, relTime, statusColor, statusLabel, type Session } from "./mock";

function bucket(min: number): "Now" | "Today" | "Earlier" {
  if (min < 30) return "Now";
  if (min < 60 * 12) return "Today";
  return "Earlier";
}

/** C — Timeline: time-first. A vertical gutter groups sessions by recency. */
export function VariantTimeline() {
  const open = SESSIONS.filter((s) => !s.settled).sort((a, b) => a.minutesAgo - b.minutesAgo);
  const groups: Array<["Now" | "Today" | "Earlier", Session[]]> = [
    ["Now", open.filter((s) => bucket(s.minutesAgo) === "Now")],
    ["Today", open.filter((s) => bucket(s.minutesAgo) === "Today")],
    ["Earlier", open.filter((s) => bucket(s.minutesAgo) === "Earlier")],
  ];

  return (
    <div className="flex h-full w-[304px] flex-col border-r border-line bg-bg">
      <header className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[13px] font-semibold">Activity</span>
        <div className="flex items-center gap-1.5">
          {PROJECTS.map((p) => (
            <span key={p.name} title={p.name} className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-3">
        {groups.map(([label, rows]) =>
          rows.length === 0 ? null : (
            <div key={label} className="relative">
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-bg/95 px-3 py-1 backdrop-blur">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">{label}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
              <div className="relative ml-[26px] border-l border-line">
                {rows.map((s) => (
                  <button key={s.id} className="group relative flex w-full items-center gap-2 py-1.5 pl-3 pr-3 text-left hover:bg-inset">
                    <span
                      className="absolute -left-[4.5px] h-2 w-2 rounded-full ring-2 ring-[var(--bg)]"
                      style={{ background: statusColor(s.exec, s.unread) }}
                    />
                    <span className="h-1.5 w-1.5 shrink-0 rounded-sm" style={{ background: projectColor(s.project) }} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{s.title}</span>
                    {s.agents ? <span className="font-mono text-[10px] text-dim">{s.agents}◆</span> : null}
                    <span className="shrink-0 font-mono text-[10px] text-dim" title={statusLabel(s.exec, s.unread)}>
                      {relTime(s.minutesAgo)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
