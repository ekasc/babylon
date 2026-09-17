# Nav IA refactor: Spaces / Agents / Tabs

Mental model: Spaces = where work belongs. Agents = what is running now.
Tabs = current working set. History = what came before.

## State (App.tsx, single canonical source)

- `tabs: Array<{path, cwd}>` — global display order (insertion). Persisted
  in `babylon:tabs` v2 `{tabs, activeBySpace}`; legacy `Record<cwd,path[]>`
  shape migrated on load (spaces order, then list order).
- `activeBySpace: Record<cwd,path>` — last activated tab per space.
  Updated at the bridge-ready choke point (line ~1035) alongside addTab.
- `activeSpace: string | null` — explicit project context, persisted
  `babylon:active-space`. Falls back to `status.cwd`. Set by openSession
  success and by space selection.
- Tab cap 24 (was 12-per-space).

## Behaviors

- openSession success → addTab (no-op if present, no reorder) +
  activeBySpace[cwd]=path + activeSpace=cwd.
- closeTab(path) → remove (order kept), release idle runtime (existing),
  fallback to neighbor (next ?? prev) else landing (activePath null,
  hasSession false). Session data untouched.
- selectSpace(cwd) → activeSpace=cwd; if activeBySpace[cwd] still open →
  openSession there; else landing (no auto-create).
- `+` → existing New Session modal with `defaultCwd=activeSpace`
  (pinned first, preselected).
- Header: project icon + name only (session title removed).
- Sidebar: flat space rows (tooltip kept, X kept), NO nested tabs;
  AGENTS section after Spaces (session-kind live only); pinned/snoozed/
  settled/archived sections stay; bottom agent dock REMOVED
  (threads/subagents/workflows live in WorkflowsPanel).
- AGENTS visibility: (execution !== "idle" || attention !== "none") &&
  !(settled && attention === "none"). Click → openSession (activates tab).

## Components (new, presentational; App owns state)

- `SessionTabs` — strip embedded in the header row (no project button;
  header is tabs + actions). ProjectIcon per tab, approval/unread dot,
  click/middle-click/×, overflow-x-auto + active scroll-into-view,
  `no-drag` so the titlebar region never swallows tab clicks.
- `SessionHistoryMenu` — chevron + recent sessions popover, reopen.
- `AgentsSection` — rows: icon, title, state text, space name.
- Pure helpers in `lib/nav-model.ts`: migrateLegacyTabs, deriveLiveAgents,
  neighbor fallback, space-tab pick. Unit-tested.

## Constraints honored

- Unread/approval/waiting/background-completion/attention propagation:
  untouched (runtimeByPath + registries as-is).
- Session persistence, shortcuts, Electron behavior: untouched.
- Base UI primitives reused (ui/Popover for history menu).
- Project identity system reused.
- No tab drag-reorder, no pinning/groups/previews.
