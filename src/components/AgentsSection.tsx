import type { LiveAgent } from "../lib/nav-model";
import { agentStateLabel } from "../lib/nav-model";
import { ProjectIcon } from "./ProjectIcon";

export interface AgentRow {
  agent: LiveAgent;
  title: string;
  projectName: string;
}

/**
 * AGENTS: live runtime monitor, not history. Sessions appear here only
 * while executing, waiting, needing input, or failed-but-unsettled;
 * settled-quiet sessions disappear (filtering is owned by
 * deriveLiveAgents). Clicking activates the session's tab.
 */
export function AgentsSection({
  rows,
  activePath,
  allCwds,
  onOpen,
}: {
  rows: AgentRow[];
  activePath: string | null;
  allCwds: string[];
  onOpen(row: AgentRow): void;
}) {
  return (
    <div>
      <div className="flex items-center gap-1 px-2.5 pb-1 pt-1">
        <span className="shelf-label">Agents{rows.length > 0 ? ` (${rows.length})` : ""}</span>
        <span className="shelf-divider" />
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-1 text-[13px] text-dim">Idle.</p>
      ) : (
        rows.map(({ agent, title, projectName }) => {
          const active = agent.path === activePath;
          const dot =
            agent.execution === "working"
              ? "bg-[var(--ok)] animate-pulse"
              : agent.execution === "failed"
                ? "bg-err"
                : agent.execution === "waiting" ||
                    agent.execution === "approval" ||
                    agent.attention === "approval"
                  ? "bg-warn animate-pulse"
                  : "bg-accent";
          return (
            <button
              key={agent.path}
              type="button"
              onClick={() => onOpen({ agent, title, projectName })}
              title={`${title} · ${projectName} · ${agentStateLabel(agent)}`}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left ${
                active ? "bg-accent/10" : "hover:bg-raised"
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{title}</span>
                <span className="flex items-center gap-1 text-[11px] text-dim">
                  <ProjectIcon cwd={agent.cwd} allCwds={allCwds} size={10} />
                  <span className="truncate">{projectName}</span>
                </span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-dim">
                {agentStateLabel(agent)}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
