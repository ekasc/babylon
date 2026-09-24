import { useEffect, useRef } from "react";
import type { AttentionState, ExecutionState } from "../sessionRuntime";

const isMacTabHint = typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? "");

export interface TabItem {
  path: string;
  cwd: string;
  title: string;
}

/** Narrow execution identity for the strip (ownership + display state). */
export interface TabExecutionState {
  path: string;
  state: ExecutionState;
}

/** Leading execution marker: where the agent is (independent of selection). */
function executionDot(state: ExecutionState): { className: string; label: string } {
  switch (state) {
    case "working":
      return { className: "bg-accent animate-pulse", label: "Agent working" };
    case "waiting":
      return { className: "bg-accent", label: "Agent waiting" };
    case "approval":
      return { className: "bg-warn animate-pulse", label: "Agent needs approval" };
    default:
      // idle | failed: the owner exists but is quiet.
      return { className: "bg-dim", label: "Execution session" };
  }
}

/**
 * Session tab strip for the current project: the active space's working set
 * (App filters cross-project tabs out before rendering). Navigation only —
 * selectedPath is view state, execution is independently rendered ownership
 * state, and closing removes only the nav tab (never a runtime; even the
 * execution-owner tab may close while work continues). Selected keeps the
 * dominant treatment (inset + 2px accent edge — "what am I looking at");
 * the execution owner gets a small leading dot wherever it sits ("where is
 * the agent"). The two never imply each other.
 */
export function SessionTabs({
  tabs,
  selectedPath,
  execution,
  attentionByPath,
  preparingSelected,
  onActivate,
  onClose,
  onNew,
  historyMenu,
}: {
  tabs: TabItem[];
  selectedPath: string | null;
  /** Current Space's execution owner, from executionsByCwd — not derived
   *  from attention or per-path liveness. */
  execution?: TabExecutionState | null;
  attentionByPath: Map<string, AttentionState>;
  /** Selected session still warming: tiny spinner on the SELECTED tab (a
   *  view concern — preparation is not execution). */
  preparingSelected?: boolean;
  onActivate(tab: TabItem): void;
  onClose(path: string): void;
  onNew(): void;
  historyMenu: React.ReactNode;
}) {
  const selectedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedPath, tabs.length]);

  // Quick-switch: mod+digit activates a visible tab (T3 ⌘1-9 thread jumps).
  // Skipped while typing in a field so composer/history shortcuts keep working.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !/^[1-9]$/.test(e.key)) return;
      const ae = document.activeElement;
      if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || (ae instanceof HTMLElement && ae.isContentEditable)) return;
      const tab = tabs[Number(e.key) - 1];
      if (!tab) return;
      e.preventDefault();
      if (tab.path !== selectedPath) onActivate(tab);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tabs, selectedPath, onActivate]);

  return (
    <div
      role="tablist"
      aria-label="Open sessions"
      className="flex h-full min-w-0 flex-1 items-stretch gap-px [-webkit-app-region:no-drag]"
    >
      <div className="flex min-w-0 flex-1 items-stretch gap-px overflow-x-auto">
        {tabs.map((tab, tabIdx) => {
          const selected = tab.path === selectedPath;
          const executing = execution != null && tab.path === execution.path;
          const execDot = executing && execution ? executionDot(execution.state) : null;
          const attention = attentionByPath.get(tab.path) ?? "none";
          return (
            <div
              key={tab.path}
              ref={selected ? selectedRef : undefined}
              role="tab"
              aria-selected={selected}
              aria-label={tab.title}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                // Clicking an executing-but-not-selected tab activates it:
                // execution is not selection.
                if (!selected) onActivate(tab);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.path);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!selected) onActivate(tab);
                }
              }}
              title={tabIdx < 9 ? `${tab.title} (${isMacTabHint ? "⌘" : "Ctrl"}+${tabIdx + 1})` : tab.title}
              className={`group/tab flex min-w-0 max-w-[200px] shrink-0 cursor-default items-center gap-1.5 border-r border-line/60 px-2.5 text-[13px] outline-none ${
                selected
                  ? "bg-inset text-fg shadow-[inset_0_2px_0_var(--accent)]"
                  : "text-dim hover:bg-inset/50 hover:text-fg"
              }`}
            >
              {execDot ? (
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${execDot.className}`} aria-label={execDot.label} />
              ) : null}
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              {selected && preparingSelected ? (
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-label="Preparing session" />
              ) : attention === "approval" ? (
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warn" aria-label="Needs input" />
              ) : attention === "unread" ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread" />
              ) : null}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.path);
                }}
                onAuxClick={(e) => e.stopPropagation()}
                tabIndex={-1}
                aria-label={`Close ${tab.title}`}
                title="Close tab (session stays in history)"
                className="shrink-0 rounded px-1 text-[12px] leading-none text-dim opacity-0 transition-opacity hover:text-err group-hover/tab:opacity-100 focus-visible:opacity-100"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 pl-1">
        <button
          type="button"
          onClick={onNew}
          title="New session"
          aria-label="New session"
          className="grid h-7 w-7 place-items-center rounded-md text-[15px] leading-none text-dim hover:bg-inset hover:text-fg"
        >
          +
        </button>
        {historyMenu}
      </div>
    </div>
  );
}
