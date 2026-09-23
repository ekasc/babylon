import { useEffect, useRef } from "react";
import type { AttentionState } from "../sessionRuntime";

const isMacTabHint = typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? "");

export interface TabItem {
  path: string;
  cwd: string;
  title: string;
}

/**
 * Session tab strip for the current project: the active space's working set
 * (App filters cross-project tabs out before rendering). Restrained and
 * flat — muted inactive tabs, a 2px accent edge on the active one. Closing
 * never touches the underlying session.
 */
export function SessionTabs({
  tabs,
  activePath,
  attentionByPath,
  preparingActive,
  onActivate,
  onClose,
  onNew,
  historyMenu,
}: {
  tabs: TabItem[];
  activePath: string | null;
  attentionByPath: Map<string, AttentionState>;
  /** Host still warming the active session: tiny spinner on its tab. */
  preparingActive?: boolean;
  onActivate(tab: TabItem): void;
  onClose(path: string): void;
  onNew(): void;
  historyMenu: React.ReactNode;
}) {
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activePath, tabs.length]);

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
      if (tab.path !== activePath) onActivate(tab);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tabs, activePath, onActivate]);

  return (
    <div
      role="tablist"
      aria-label="Open sessions"
      className="flex h-full min-w-0 flex-1 items-stretch gap-px [-webkit-app-region:no-drag]"
    >
      <div className="flex min-w-0 flex-1 items-stretch gap-px overflow-x-auto">
        {tabs.map((tab, tabIdx) => {
          const active = tab.path === activePath;
          const attention = attentionByPath.get(tab.path) ?? "none";
          return (
            <div
              key={tab.path}
              ref={active ? activeRef : undefined}
              role="tab"
              aria-selected={active}
              aria-label={tab.title}
              tabIndex={active ? 0 : -1}
              onClick={() => {
                if (!active) onActivate(tab);
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
                  if (!active) onActivate(tab);
                }
              }}
              title={tabIdx < 9 ? `${tab.title} (${isMacTabHint ? "⌘" : "Ctrl"}+${tabIdx + 1})` : tab.title}
              className={`group/tab flex min-w-0 max-w-[200px] shrink-0 cursor-default items-center gap-1.5 border-r border-line/60 px-2.5 text-[13px] outline-none ${
                active
                  ? "bg-inset text-fg shadow-[inset_0_2px_0_var(--accent)]"
                  : "text-dim hover:bg-inset/50 hover:text-fg"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              {active && preparingActive ? (
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
