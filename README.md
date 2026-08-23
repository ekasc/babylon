# Babylon

Babylon is a secure desktop workspace for the [pi coding agent](https://github.com/badlogic/pi-mono). It uses your existing pi models, skills, extensions, prompts, themes, and sessions inside an Electron and React interface.

## Highlights

- Fast project and session navigation backed by one shared model runtime and isolated project services.
- Streaming conversations with reasoning, tool activity, syntax highlighting, images, steer/follow-up, and abort controls.
- Skills, slash commands, prompt templates, extension dialogs, model selection, thinking controls, and context statistics.
- A focused primary session with a persistent contextual workspace for workflows, threads, and subagents.
- Session History derived from Pi's real append-only ancestry, including true branch visibility and current-session forking.
- Exact Git-project rollback of conversation and filesystem state, with preview, persistent undo, path validation, and no changes to the visible Git branch or index.
- Transactional Git worktrees for isolated experiments.
- Light and dark themes with reduced-motion, reduced-transparency, increased-contrast, and keyboard-accessibility support.

## Requirements

- Node.js 24 or newer
- pnpm
- Git
- A working `pi` installation containing `@earendil-works/pi-coding-agent`

Babylon locates the Pi package from `PI_PACKAGE_DIR`, the `pi` executable on `PATH`, or the global npm package directory.

## Development

```bash
pnpm install
pnpm dev
```

Useful checks:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

`PIDECK_SMOKE` starts Electron and exits automatically after the specified number of milliseconds.

If Babylon cannot locate the Pi package automatically, provide its package directory explicitly:

```bash
PI_PACKAGE_DIR=/path/to/@earendil-works/pi-coding-agent pnpm dev
```

## Architecture

```text
electron/main.ts              Electron lifecycle and validated IPC
electron/pi-host.ts           In-process Pi runtime and session coordination
electron/snapshot-store.ts    Isolated Git-backed filesystem snapshots
electron/rollback-store.ts    Persistent rollback checkpoints and undo state
electron/session-history.ts   Conversation ancestry projection
electron/activity.ts          Threads and subagent activity
src/App.tsx                   Renderer orchestration
src/store.ts                  Streaming transcript state
src/components/               Conversation, composer, history, and workspace UI
```

Pi session files remain append-only. Rollback navigates Pi's native conversation tree and stores filesystem snapshots outside the source worktree. Internal `pideck:*` IPC names and `pideck/*` worktree branches are retained for compatibility.

## Verification

The repository includes unit and integration coverage for session indexing, deep session trees, activity, image payloads, history projection, snapshot safety, rollback persistence, restart recovery, and end-to-end rollback/undo behavior.
