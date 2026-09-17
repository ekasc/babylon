import { useState } from "react";
import { PROJECTS, SESSIONS, relTime, statusColor, statusLabel } from "./mock";

/** A — Activity rail: two-pane. Icon rail picks a project; flat list is that project. */
export function VariantRail() {
  const [active, setActive] = useState(PROJECTS[0].name);
  const project = PROJECTS.find((p) => p.name === active)!;
  const sessions = SESSIONS.filter((s) => s.project === active && !s.settled);

  return (
    <div className="flex h-full">
      <div className="flex w-[56px] flex-col items-center gap-1 border-r border-line bg-inset py-2">
        {PROJECTS.map((p) => {
          const count = SESSIONS.filter((s) => s.project === p.name && (s.exec !== "idle" || s.unread)).length;
          const on = p.name === active;
          return (
            <button
              key={p.name}
              onClick={() => setActive(p.name)}
              title={p.name}
              className={`relative grid h-10 w-10 place-items-center rounded-lg ${on ? "bg-raised" : "hover:bg-raised/60"}`}
            >
              <span className="grid h-6 w-6 place-items-center rounded-md text-[12px] font-bold" style={{ background: p.color, color: "var(--bg)" }}>
                {p.name[0].toUpperCase()}
              </span>
              {count > 0 ? (
                <span className="absolute right-1 top-1 grid h-3.5 min-w-3.5 place-items-center rounded-full px-1 font-mono text-[9px] text-bg" style={{ background: "var(--accent)" }}>
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
        <div className="mt-auto grid h-10 w-10 place-items-center rounded-lg text-dim hover:bg-raised/60">⚙</div>
      </div>

      <div className="flex w-[268px] flex-col border-r border-line bg-bg">
        <header className="flex items-start justify-between gap-2 px-3 py-2.5">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">{project.name}</div>
            <div className="truncate font-mono text-[10px] text-dim">{project.cwd}</div>
          </div>
          <button className="shrink-0 rounded-md px-2 py-1 text-[11px] text-dim hover:bg-inset">+ New</button>
        </header>
        <div className="mx-3 mb-2 flex items-center gap-1.5 rounded-md border border-line bg-inset px-2 py-1.5 text-[12px] text-dim">
          <span>⌕</span>
          <span>Search {project.name}</span>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {sessions.map((s) => (
            <button key={s.id} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-inset">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor(s.exec, s.unread) }} title={statusLabel(s.exec, s.unread)} />
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{s.title}</span>
              {s.agents ? <span className="shrink-0 rounded bg-inset px-1 font-mono text-[10px] text-dim">{s.agents}◆</span> : null}
              <span className="shrink-0 font-mono text-[10px] text-dim">{relTime(s.minutesAgo)}</span>
            </button>
          ))}
          {sessions.length === 0 ? <p className="px-2 py-6 text-center text-[12px] text-dim">No open sessions</p> : null}
        </div>
      </div>
    </div>
  );
}
