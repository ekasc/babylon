# Babylon Daily-Driver Handoff

## Objective

Complete the minimum daily-driver milestones in this order:

1. Real process manager
2. LSP diagnostics loop
3. Task-owned session/worktree/process lifecycle
4. Hooks and completion contracts
5. Daemon ownership of tasks and `PiHost`
6. Attention inbox fed by real failures

Use small, end-to-end milestones. After each milestone is verified, commit it and push it to the current branch. Repository policy still requires explicit confirmation before each push.

## Current branch and published state

- Branch: `main`
- Remote: `origin/main`
- Latest published milestone commit: `d3708c5 Add Electron-owned process management`
- That commit was pushed successfully to `origin/main`.
- No LSP work has been committed or pushed.

## Milestone 1: real process manager — complete

Electron now owns real child processes. The renderer can run a project command and display its PID, cwd, bounded stdout/stderr, detected output ports, state, and exit code. Kill terminates the real process group. IPC validates inputs and app shutdown disposes children.

Published files include:

- `electron/process-manager.ts`
- `electron/process-manager.test.ts`
- process-related wiring in `electron/main.ts` and `electron/preload.ts`
- process contracts in `src/bridge.ts` and `src/process-model.ts`
- `src/components/ProcessPanel.tsx`
- process state wiring in `src/App.tsx`
- the updated terminal status in `ROADMAP.md`

Verification completed before commit:

- `pnpm exec vitest run electron/process-manager.test.ts src/process-model.test.ts` — 20/20 passed
- `pnpm test` — 57 files, 426/426 tests passed
- `pnpm build` — typecheck, renderer build, and Electron build passed
- `pnpm smoke` — passed
- Live Electron probe — real stdout/stderr, PID, port 43123, kill, and exit code 7 all passed

Remaining terminal work is intentionally outside that milestone: PTY/stdin, restart, socket probing, Pi process tools, agent-created process registration, and daemon ownership.

## Milestone 2: LSP diagnostics loop — partial and unverified

An interrupted OpenCode CLI worker left a substantial partial implementation. Do not discard it blindly, but do not treat it as complete.

New untracked files:

- `electron/lsp-manager.ts`
- `electron/lsp-manager.test.ts`
- `src/components/ProblemsPanel.tsx`

LSP-related edits also exist in these shared files:

- `electron/main.ts`
- `electron/pi-host.ts`
- `electron/preload.ts`
- `src/App.tsx`
- `src/bridge.ts`

Those shared files also contain unrelated pre-existing work. Preserve unrelated hunks and stage LSP changes selectively.

### What the partial implementation attempts

- Project-scoped language-server ownership in Electron.
- Local/global discovery for TypeScript, Python, Go, and Rust servers.
- Bounded source-file discovery and filesystem watching.
- LSP initialize/initialized, request correlation, framing, server request responses, and diagnostics normalization.
- `didOpen`, `didChange`, `didSave`, and `didClose` synchronization.
- Bounded crash restart and unavailable-server states.
- LSP IPC and renderer subscriptions.
- A Problems panel showing server state and grouped diagnostics.
- Debounced delivery of newly introduced errors/warnings to Pi through `PiHost.notifyDiagnostics`.

### Verification currently known

- `pnpm typecheck` — passed with the partial implementation.
- Existing `electron/lsp.test.ts` — 14/14 passed.
- The first three `electron/lsp-manager.test.ts` cases pass:
  - initialize plus `didOpen`/`didChange`
  - normalized diagnostics and Pi callback
  - project switch and old-child cleanup
- Running the full `electron/lsp-manager.test.ts` file hangs during or after the crash-restart case and exceeded a 60-second command timeout.
- No full test suite, production build, smoke test, or live Electron verification has been completed after the LSP edits.

## Immediate next actions

1. Reproduce the LSP test hang with:

   ```sh
   pnpm exec vitest run electron/lsp-manager.test.ts -t "crash restarts" --reporter=verbose
   ```

2. Fix the lifecycle root cause. Inspect duplicate `error`/`close` handling, pending initialize requests, restart timers, and child cleanup. Prove no child or watcher remains after each test.
3. Review and simplify `electron/lsp-manager.ts`. It is currently about 1,200 lines and contains suspicious or incomplete areas:
   - the epoch guard in `discoverAndWatch` has an empty body;
   - `isExcludedPath` relies on global `activeCwd` instead of the owning project;
   - `stopServer` kills directly rather than performing the promised `shutdown`/`exit` sequence;
   - spawn `error` and `close` can both mutate state and may schedule conflicting restarts;
   - unavailable-command retry behavior needs deterministic tests;
   - snapshot construction contains redundant per-server diagnostic aggregation;
   - watcher behavior and path handling need Windows review.
4. Run all focused tests until they terminate cleanly:

   ```sh
   pnpm exec vitest run electron/lsp-manager.test.ts electron/lsp.test.ts
   ```

5. Run broader verification:

   ```sh
   pnpm test
   pnpm typecheck
   pnpm build
   pnpm smoke
   ```

6. Perform live Electron verification with a disposable project containing a fake executable stdio language server. Confirm:
   - the active project starts the server;
   - Problems shows the real PID/state;
   - initial diagnostics appear with correct file and 1-based position;
   - changing a file produces a higher document version and updated diagnostics;
   - newly introduced errors/warnings appear as `babylon_diagnostics` context in the active session;
   - project switching kills the old server and ignores stale diagnostics;
   - app quit leaves no child process.
7. Update `ROADMAP.md` only after the live path passes. LSP should likely move from Foundation to Partial unless all promised daily-driver behavior is genuinely complete.
8. Stage only LSP-specific files and hunks. Commit after verification, then obtain explicit push confirmation and push `main`.

## Working-tree warning

The working tree contains many unrelated changes that predate the partial LSP milestone, including Git commit/push work, settings, package/workspace files, and QA scripts. Do not reset, clean, overwrite, or include them in the LSP commit.

Known unrelated paths include:

- `electron/app-settings.ts`
- `electron/git.ts` and Git tests/helpers
- `electron/subagents.ts`
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- `src/components/GitView.tsx`
- `src/components/SettingsPage.tsx`
- `scripts/e2e-live*.mjs`

Use selective staging for shared LSP files.

## Delegation constraint

The native `subagent` tool does not expose a model-selection field and cannot guarantee `opencode-go/muse-spark-1.2-contributor`. The exact Muse model is available through `opencode run`, but that is a CLI worker rather than a native subagent. The user questioned using the CLI, so resolve this choice before delegating again. Direct implementation by the root agent is the reversible default if no choice is made.
