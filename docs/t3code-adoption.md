# t3code → pi Architecture Study

Source: `/tmp/t3inspect/t3code` (commit 31 Aug 2025, 39 top-level dirs, 9 packages, 5 apps)

## 1. t3code architecture summary

**Server** `apps/server` — Effect RPC WS (`packages/contracts` `WsRpcGroup`) serving `GET /ws` via `RpcServer.toHttpEffectWebsocket`. Orchestration is event-sourced: `OrchestrationEngine.dispatch` enqueues `CommandEnvelope`, single fiber `processEnvelope` → `decideOrchestrationCommand` (pure) → txn append events + `projector` + receipt → swap read model + publish. Follow-up work runs in `DrainableWorker` (queue + outstanding TxRef, `drain()` for tests) and `KeyedCoalescingWorker` (latest per key, coalesced). Checkpointing via git hidden refs (`VcsCheckpointOps`, `CheckpointReactor`, `CheckpointDiffQuery`). 5 provider drivers in `builtInDrivers.ts`.

**Client** `apps/web`/`apps/mobile` share `packages/client-runtime` (connection supervisor, `RpcSessionFactory`, Atom factories for `threads`, `projectGrouping`, `threadSort`, `shellReducer`). `packages/shared` holds pure helpers: `chatList`, `composerTrigger`, `composerInlineTokens`, `searchRanking`, `usageFormat`/`usageMerge`, `filePreview`, `path`, `semver`, `projectFavicon`, `terminalLabels`.

**Why Effect-heavy parts are not pi-compatible:** `DrainableWorker`/`KeyedCoalescingWorker`/`RpcSessionFactory` require `effect` (`TxQueue`, `Scope`, `Atom`). Pi is Vite+React+Electron with plain TS (`vitest` 4, no `effect` dep). Porting those would be a rewrite, not a take.

## 2. Good → portable (pure, zero deps)

| t3code source | pi dest | what | why portable |
|---|---|---|---|
| `shared/composerTrigger.ts` | `lib/composerTrigger.ts` | `@path`/`$skill`/`/command` at cursor, `serializeMentionPath`, `replaceTextRange` | pure string, no Effect |
| `shared/chatList.ts` | `lib/chatList.ts` | `resolveChatListAnchoredEndSpace` | 30 LOC, pure |
| `client-runtime/state/threadSort.ts` (pinned section) | `lib/pinOrder.ts` | base-26 `pinOrderKeyBetween`, `generateSpreadPinOrderKeys`, `planPinnedReorder`, `sortPinnedThreadsByOrderKey` | pure string math |
| `shared/threadSort` timestamp helpers | `lib/threadSort.ts` | `toSortableTimestamp`, `getThreadSortTimestamp`, `activeThreadAnchorTimestampMs`, `sortThreads` | native sort, no `effect/Array` |
| `shared/usageFormat.ts` (trim part) | `lib/usageFormat.ts` | `formatTokens` (K/M/B/T 3 sig figs), `formatUsd/Count/Percent` | `Intl` only |
| `shared/filePreview.ts` | `lib/filePreview.ts` | browser/image preview extension lists, `isWorkspacePreviewEntryPath` | pure |
| `shared/searchRanking.ts` | `lib/searchRanking.ts` | tiered `scoreQueryMatch` + `insertRankedSearchResult` | pure |
| `shared/path.ts` | `lib/path.ts` | `normalizeProjectPathForComparison/Dispatch` | pure |
| `shared/terminalLabels.ts` | `lib/terminalLabels.ts` | `getTerminalLabel`, `nextTerminalId` | pure |
| `shared/composerInlineTokens.ts` | `lib/composerInlineTokens.ts` | `@`/`$`/`[label](path)` collection, capped file-link length | pure regex |
| `shared/String.ts` | `lib/string.ts` | `truncate` | pure |
| `shared/projectFavicon.ts` | `lib/projectFavicon.ts` | `getProjectFaviconCacheKey`, `isFallbackUrl` | pure URL |
| `shared/semver.ts` | `lib/semver.ts` | `normalize/parse/compare/satisfies` | pure |
| `shared/devProxy.ts` | `lib/devProxy.ts` | `DEV_PROXIED_PATH_PREFIXES`, `isDevProxiedPath` | pure |
| `shared/themePalettes.ts` | `lib/themePalettes.ts` | `BUILT_IN_THEME_IDS`, `RESERVED_THEME_IDS`, `UNPUBLISHABLE_THEME_IDS` | pure constants |

**Integrated so far:**
- `composerTrigger` → `Composer.tsx` replaces `commandTokenAtStart` (now handles `/` after `\n`, keeps `rankCommands` pipeline)
- `searchRanking` → `commands.ts:rankCommands` now tiered `exact:0/prefix:10/boundary:20/includes:40/fuzzy:80` (lower better)
- `usageFormat` → `store.ts:fmtTokens` + `lib/format.ts:formatTokens` unified via wrapper (`null→"0"`)
- `path` → `App.tsx:shortCwd` now `normalizeProjectPathForDispatch` before `~/` replace
- `string` → `Composer.tsx:trunc` delegates to `lib/string:truncate` (keeps `\s+` collapse)
- `terminalLabels` → `tasks.ts:allocateTerminal` uses `nextTerminalId` (lowest unused `term-N`)
- `themePalettes` + `devProxy` + `semver` etc. remain standalone pure libs ready for `lib/theme.ts`/`vite.config` wiring

## 3. Not taken (incompatible without Effect rewrite)

- `OrchestrationEngine` event sourcing, `DrainableWorker`/`KeyedCoalescingWorker` (require `effect` TxQueue/Scope)
- `RpcSessionFactory` + `connection/supervisor` (Effect RPC + Atom) — pi uses plain `daemon-protocol` WS `daemon-client`
- `CheckpointReactor` git hidden refs — pi has `rollback-store`/`recap-store` simpler
- `client-runtime` Atom factories (threads, shell, preview) — pi uses `store.ts` reducer

## 4. Verification

- Each lib added with `*.test.ts` mirroring t3code invariants (or adapted where `isValidPinOrderKey` rejects trailing `a` and `formatTokens` `1.5K→1.50K`)
- `pnpm test` 77→86 files, 637→676 tests across increments, all passing (currently 86 files 676 tests)
- `tsc --noEmit` clean, `vite build` ✓ after each increment
- No new `effect` dep, no `contracts` import in ported libs; `lib/storage.ts` deduplicates `babylon: ↔ pideck:` fallback

## 5. Next smallest safe steps (if continuing)

1. Wire `filePreview.isWorkspacePreviewEntryPath` into `preview-model.ts` routing / file tree
2. Wire `themePalettes.RESERVED_THEME_IDS` into `lib/theme.ts` custom-palette validation
3. Adopt `projectGrouping` logical vs physical keys for repo-scoped grouping (requires `contracts` type adapt, larger)
4. Evaluate `OrchestrationEngine` event-sourcing for pi's `daemon-runtime` — requires `effect` rewrite, not compatible as small step
