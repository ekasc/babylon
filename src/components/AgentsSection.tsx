import type { ExecutionTree } from "../lib/execution-tree";
import { ProjectIcon } from "./ProjectIcon";

function rootStateLabel(state: ExecutionTree["state"]): string {
  if (state === "approval") return "Needs input";
  if (state === "waiting") return "Waiting";
  return "Working";
}

/**
 * AGENTS: live EXECUTION MONITOR — one root per project (from
 * executionsByCwd) with the children that session owns (subagents, threads,
 * workflows). It is not session history, not an inbox, and not a control
 * plane: clicking a root VIEWS the owning session without changing
 * execution; child rows are monitoring-only (Activity is the inspector).
 * Project identity lives on the root, never repeated per child.
 */
export function AgentsSection({
  trees,
  selectedPath,
  onOpenRoot,
}: {
  trees: ExecutionTree[];
  /** Viewed session (view highlight only — never membership). */
  selectedPath?: string | null;
  onOpenRoot(tree: ExecutionTree): void;
}) {
  return (
    <div>
      <div className="flex items-center gap-1 px-2.5 pb-1 pt-1">
        <span className="shelf-label">Agents</span>
        <span className="shelf-divider" />
      </div>
      {trees.length === 0 ? (
        <p className="px-5 py-1 text-[13px] text-dim">Idle.</p>
      ) : (
        trees.map((tree) => {
          const selected = tree.sessionFile === selectedPath;
          const dot =
            tree.state === "working" ? "bg-[var(--ok)] animate-pulse" : "bg-warn animate-pulse";
          return (
            <div key={tree.sessionFile} className="px-1.5">
              <button
                type="button"
                onClick={() => onOpenRoot(tree)}
                title={`${tree.title} · ${tree.projectName} · ${rootStateLabel(tree.state)}`}
                className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left ${
                  selected ? "bg-accent/10" : "hover:bg-raised"
                }`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{tree.title}</span>
                  <span className="flex items-center gap-1 text-[11px] text-dim">
                    <ProjectIcon cwd={tree.cwd} allCwds={[]} size={10} />
                    <span className="truncate">{tree.projectName}</span>
                  </span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-dim">{rootStateLabel(tree.state)}</span>
              </button>
              {tree.children.length > 0 ? (
                <div className="ml-4 border-l border-line/60 pb-0.5 pl-2">
                  {tree.children.map((child) => (
                    <div
                      key={child.key}
                      title={child.label}
                      className="flex items-center gap-2 py-0.5 pr-1.5 text-[12px] text-dim"
                    >
                      <span className="min-w-0 flex-1 truncate">{child.label}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-dim">{child.statusLabel}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
