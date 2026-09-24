# Base UI migration — standing goal

Objective: back every hand-rolled interactive pattern with a Base UI primitive.
Hard constraint: **no redesign, no visual or behavioral change**. Babylon owns
all styling classes and layout; Base UI owns focus, dismissal, ARIA, portals.
Reusable components live in `src/components/ui/` with co-located contract
tests (`*.test.tsx`), following the `ModalDialog` precedent.

## Done

- `ui/Dialog.tsx` (`ModalDialog`) + tests. Adopted by: DiagnosticsPanel,
  RollbackConfirm, PromptHost, GitCommitPopover, CommandPalette,
  NewSessionModal, BotsPanel, ProjectPanel.
- `ui/Input.tsx` (`TextInput`, `Textarea`) + tests. (No adopters yet —
  settings forms still use `.settings-input` directly.)
- `ui/Popover.tsx` (`PopoverRoot/Trigger/Panel`) + tests. Inline-absolute
  (container portal) and body-portal (fixed) modes, collision off.
  Adopted by: ModelPicker, ComposerModelPicker. (ThinkingPicker,
  ComposerThinkingPicker, PermissionModePicker, StatsPopover,
  SettingsThinkingPicker, ProjectFilter were already on raw Base UI.)
- `ui/Select.tsx` (`Select/SelectOption`) + tests. Adopted by:
  SettingsModels, SettingsContext, PermissionRulesSection, GitView.
- `ui/Switch.tsx` + `ui/Checkbox.tsx` + tests. Adopted by:
  SettingsBackground (switch), SettingsAppearance, BotsPanel,
  ProjectPanel ×2. Label-wrapped rows keep text-toggles via a
  closest("button") click guard.
- SettingsModelPicker + SettingsAppearance font dropdown → `ui/Popover`
  (inline-absolute). `matchTriggerWidth` added (CSS `--anchor-width`)
  after proving `alignItemWithTrigger` is Select-only.

## Audited, deliberately NOT migrated

- BotMentionMenu / CommandMenu: pure presentational listboxes; the
  Composer combobox owns all behavior. Nothing for a primitive to own.
- Provider `role=tab` rows inside the model pickers: custom ←→ keyboard
  already wired with roles; Base Tabs would reshape panel DOM.
- `turn-fold` (ChatView): grid-rows animation is pixel-specific; Base
  Collapsible's height animation would re-time it.
- Settings section nav: plain buttons switching panels, not tabs; adding
  tab semantics would change keyboard behavior.

## Inventory (hand-rolled → target)

| Pattern | Instances | Target primitive |
|---|---|---|
| Anchored pickers (`relative` + `absolute top-full`, outside mousedown, Esc, custom listbox keys) | ModelPicker, ComposerModelPicker, ThinkingPicker, ComposerThinkingPicker, PermissionModePicker, StatsPopover | `ui/Popover.tsx` — Root/Trigger/Panel, **inline (no portal)**, `positionMethod="absolute"`, collision avoidance OFF, so paint is identical. Picker keeps its own listbox keyboard + autofocus. |
| Context/action menus (`.thread-menu`, cursor-anchored?) | Sidebar menus, ProjectFilter | `ui/Menu.tsx` — audit each menu's anchoring first; same zero-pixel-move rule. |
| Native `<select>` | PermissionRulesSection, GitView, SettingsModels, SettingsContext | `ui/Select.tsx` — trigger + listbox in Babylon menu classes. Visible change risk: native menu → custom listbox. Same visual language, needs explicit user eyeball per instance. |
| Checkboxes / switches | BotsPanel, SettingsBackground, SettingsAppearance, ProjectPanel | `ui/Checkbox.tsx` / `ui/Switch.tsx` — same classes, Base owns checked/focus semantics. |
| Settings navigation | SettingsPage (+ SettingsSidebar) | Audit: if tabs → `ui/Tabs.tsx`. |
| Folds (`turn-fold` grid-rows animation) | ChatView | Audit: `ui/Collapsible.tsx` only if panel-height animation matches current paint. |

## Rules

- One phase at a time; typecheck + full suite green before next.
- Only files that trace to the phase. No drive-by refactors.
- `git status` check before/after: unrelated working-tree changes are pre-existing, never touch.
- If a primitive cannot hold the current pixels, stop and report — do not reshape the UI to fit the primitive.

## Phase order

1. `ui/Popover.tsx` + tests → migrate PermissionModePicker (smallest) → then remaining pickers.
2. `ui/Menu.tsx` → Sidebar menus, ProjectFilter.
3. `ui/Select.tsx` → the four native selects.
4. `ui/Checkbox.tsx` + `ui/Switch.tsx` → toggles.
5. Tabs / Collapsible only after audit confirms pixel-parity is possible.
