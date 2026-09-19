import { useEffect, type ReactNode } from "react";
import { PlusIcon, XIcon } from "./icons";

// The one right sidebar. It either shows its index, a grid of the features
// that act on the current session, or one open tab per feature instance.
//
// It is the same container the app already used for the browser, branches and
// activity panes (`context-workspace`, `context-header`, `context-resizer`), so
// there is a single right-hand column rather than one per feature. The tab
// strip mirrors the browser's own tab row, lifted here so every feature gets
// tabs and several features can stay open at once.

export type SessionMenuItem = {
  id: string;
  label: string;
  icon: ReactNode;
  /** What the feature is for, shown on hover. */
  hint: string;
  /** Count to surface on the tile, for features with pending work. */
  badge?: number;
  /** True when the feature needs something the current view does not have. */
  disabled?: boolean;
};

export type SessionTab = {
  key: string;
  label: string;
  icon: ReactNode;
  loading?: boolean;
};

export default function SessionSidebar({
  width,
  onResizeStart,
  items,
  tabs,
  /** Key of the open tab; null shows the grid with the strip above it. */
  activeKey,
  onOpen,
  onFocus,
  onCloseTab,
  onShowGrid,
  onClose,
  children,
}: {
  width: number;
  onResizeStart(event: React.PointerEvent<HTMLDivElement>): void;
  items: SessionMenuItem[];
  tabs: SessionTab[];
  activeKey: string | null;
  /** A grid tile always opens a new tab. */
  onOpen(id: string): void;
  onFocus(key: string): void;
  onCloseTab(key: string): void;
  onShowGrid(): void;
  onClose(): void;
  children: ReactNode;
}) {
  // Escape unwinds one step: back to the grid first, then out of the sidebar.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (activeKey) onShowGrid();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeKey, onShowGrid, onClose]);

  return (
    <aside className="context-workspace relative flex h-full min-h-0 shrink-0 flex-col" style={{ width }}>
      <div
        className="context-resizer"
        role="separator"
        aria-label="Resize session sidebar"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
      />
      {tabs.length === 0 ? (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-bg px-4">
          <span className="shrink-0 text-[14px] font-semibold tracking-tight">Session</span>
          <button onClick={onClose} className="context-header-button ml-auto" title="Close the sidebar" aria-label="Close the sidebar">
            <XIcon size={14} />
          </button>
        </div>
      ) : (
        <div className="flex h-11 shrink-0 items-stretch gap-1 border-b border-line bg-bg px-2 pt-2" role="tablist" aria-label="Open features">
          <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
            {tabs.map((tab) => {
              const isActive = tab.key === activeKey;
              return (
                <div
                  key={tab.key}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onFocus(tab.key)}
                  title={tab.label}
                  className={`flex min-w-0 max-w-[160px] shrink-0 cursor-pointer items-center gap-1.5 self-end rounded-t-md px-2 py-1.5 text-[12px] ${
                    isActive ? "bg-inset text-fg" : "text-dim hover:bg-inset/60 hover:text-fg"
                  }`}
                >
                  {tab.loading ? <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" /> : null}
                  {tab.icon}
                  <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.key);
                    }}
                    title={`Close ${tab.label}`}
                    aria-label={`Close ${tab.label}`}
                    className="grid shrink-0 place-items-center rounded p-0.5 text-dim hover:text-fg"
                  >
                    <XIcon size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onShowGrid}
            title="Show all features"
            aria-label="Show all features"
            className="grid shrink-0 place-items-center self-center rounded-md p-2 text-dim hover:bg-inset/60 hover:text-fg"
          >
            <PlusIcon size={14} />
          </button>
          <button onClick={onClose} className="context-header-button shrink-0 self-center" title="Close the sidebar" aria-label="Close the sidebar">
            <XIcon size={14} />
          </button>
        </div>
      )}
      {activeKey ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        <div className="context-content flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
          <div className="m-auto grid grid-cols-2 gap-2">
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => onOpen(item.id)}
                title={item.hint}
                aria-pressed={false}
                disabled={item.disabled}
                className="session-tile"
              >
                {item.icon}
                <span>{item.label}</span>
                {item.badge ? <span className="session-tile-count">{item.badge}</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
