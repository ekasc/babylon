# Plan: Pi Settings page

Flesh out the (currently tiny) settings surface into a real **Settings** overlay
with tabs. The first tab, **Pi**, lets the user configure model selection and
reasoning for chat and title generation, plus per-model custom context windows.

## Goals

- Replace the Sidebar's 3-item theme popover with a full Settings overlay.
- Tab 1 — **Pi**:
  - **Chat** model picker + reasoning (applies to the live session, like the
    composer, and is remembered).
  - **Title generation** model picker + reasoning (used by the auto-naming /
    recap pipeline; persisted).
  - **Context windows**: an editable override per available model, persisted
    and applied to `getModels()` so the picker reflects the customized window.
- Tab 2 — **Appearance**: theme (light / dark / system).

## Design decisions

- **Persistence**: a single JSON file in Electron `userData`
  (`pideck-settings.json`), owned by Babylon (separate from pi's per-project
  settings). Shape:
  ```ts
  interface PiSettings {
    chatModel?: { provider; modelId };
    chatReasoning?: string;
    titleModel?: { provider; modelId };
    titleReasoning?: string;
    contextWindowOverrides?: Record<"provider/model", number>;
  }
  ```
- **Chat model/reasoning**: selecting it in Settings calls the existing
  `setModel` / `setThinking` on the live session (so it takes effect
  immediately) and also persists the choice so the page remembers it.
- **Title model/reasoning**: persisted only; consumed by the host's cheap-call
  pipeline (`askCheap`) which previously hardcoded `opencode-go/deepseek-v4-flash`
  at `reasoning: "low"`.
- **Context windows**: overrides are merged into `getModels()` output (server
  side), so the change is authoritative for everything that reads the catalogue.

## Files

1. `electron/app-settings.ts` (new) — `getSettings()` / `saveSettings()` against
   `pideck-settings.json`.
2. `electron/pi-host.ts` — import settings; apply overrides in `getModels()`;
   use configured title model + reasoning in `askCheap()`; add `getSettings()` /
   `setSettings()` methods.
3. `electron/main.ts` — register `pideck:get-settings` / `pideck:set-settings`.
4. `electron/preload.ts` — expose `getSettings` / `setSettings`.
5. `src/bridge.ts` — `PiSettings` type + `getSettings` / `setSettings` in the
   `Bridge` interface and stub.
6. `src/components/SettingsPage.tsx` (new) — tabbed overlay (Pi first, then
   Appearance). Reuses `ModelPicker` + `ThinkingPicker`.
7. `src/App.tsx` — own theme state; render `<SettingsPage>`; pass models,
   thinking levels, agent state, setModel/setThinking callbacks, theme.
8. `src/components/Sidebar.tsx` — drop the inline theme popover; add
   `onOpenSettings` prop wired to the gear button.
9. `src/styles.css` — settings overlay / tab / field styling.

## Verification

- `npm run typecheck` (renderer + electron compile clean).
- Manual: open Settings (gear) → Pi tab: pick chat model + reasoning (chat
  switches live), pick a title model + reasoning, edit a model's context window
  and confirm it persists across reopen; Appearance tab toggles theme.
- Electron unit tests still pass (`npm test`) — no behavior change to existing
  host paths beyond the two targeted spots.
