# PiDeck — Staged Implementation Plan (synthesis of six inspections)

Synthesized from: host/session lifecycle · chat performance · sidebar/session indexing ·
feature bridges (workflows/threads/subagents) · command palette/activity center · testability/security.

**Guiding rules**
- Correctness dependencies land before cosmetic work.
- Every slice is independently shippable and verified; nothing lands without a gate.
- No new extension schemas are invented. All wire contracts below are derived from the
  verified SDK surface (`@earendil-works/pi-coding-agent` v0.84.1) and the on-disk formats
  the inspections already traced. Session files stay **append-only / read-only** — no
  destructive migrations.

**Objective → slice map**

| Objective | Slices |
|---|---|
| Highly performant navigation/UI/chat | 1, 2, 7 |
| No feature compromise | all (workflows/tree/dialogs/worktrees preserved) |
| Skills + slash commands work in chat | 1 (per-cwd loader), 4 |
| TUI/GUI session changes never stale | 1 (sessionId stamping), 3 (watcher + external change) |
| Sidebar not a mess of threads | 3 |
| Polished Workflows / Subagents / Threads | 5 |

---

## Dependency order

```
Slice 1 (host_sync correctness core)  ← FIRST, everything correctness-critical depends on it
   ├─ Slice 2 (chat render hot path)          ← independent perf P0s, but touches App.tsx/main.ts
   ├─ Slice 3 (session index + sidebar)       ← independent; largest surface
   │      └─ Slice 4 (skills/slash in chat)   ← depends on 1's per-cwd loader
   │             └─ Slice 5 (palette + activity center) ← depends on 3 (groups) + 4 (catalog)
   ├─ Slice 6 (Electron hardening)            ← independent, small
   └─ Slice 7 (perf + a11y polish)            ← cosmetic, last
```

Slices 2/3/6 are mutually independent and may be parallelized once Slice 1 merges.

---

## Slice 1 — `host_sync` correctness core (FIRST, immediately implementable)

**Files:** `electron/pi-host.ts`, `electron/main.ts`, `src/App.tsx`, `src/sessionLifecycle.ts` (new),
`package.json`, plus new tests.

**Why first:** every per-project feature (extensions, skills, prompt templates, project settings)
is wrong today because `DefaultResourceLoader`/`SettingsManager` are bound to the *launch* cwd
(`pi-host.ts` `start()`) and never rebound on switch. Rapid navigation also races a single
`AgentSessionRuntime` that is **not reentrant** (SDK `agent-session-runtime.js` has no queue).
This slice is the root-cause fix for both.

### 1a. Per-cwd service bundles (P0#1)

In `electron/pi-host.ts`:

- Replace the single `services` field with:
  ```ts
  private services!: Services;                     // launch bundle (fast fallback)
  private bundles = new Map<string, Services>();   // key: resolve(cwd)
  ```
- In `start()`: seed `bundles.set(resolve(cwd), this.services)` after the launch bundle is built.
- In the `createRuntime` factory (`pi-host.ts`), replace
  `const services = { ...this.services, cwd: input.cwd }` with
  `const services = await this.bundleFor(input.cwd)` where:
  ```ts
  private async bundleFor(cwd: string): Promise<Services> {
    const key = resolve(cwd);
    const hit = this.bundles.get(key);
    if (hit) return hit;                            // ~1ms fast path (unchanged cwd)
    const settingsManager = SettingsManager.create(cwd, this.services.agentDir);
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: this.services.agentDir, settingsManager });
    await resourceLoader.reload();                  // discovers cwd/.pi/extensions, skills, templates, settings
    const bundle = { ...this.services, cwd, settingsManager, resourceLoader };
    this.bundles.set(key, bundle);
    return bundle;
  }
  ```
- Keep the shared `ModelRuntime` (`this.services.modelRuntime`) — it is cwd-independent.
- Rely on the SDK's `clearExtensionCache()` on cwd change (already invoked inside the loader) for
  correct per-project extension instances; no extra cache invalidation needed.
- Stash `result.extensionsResult` (already returned by `createAgentSessionFromServices`, already in
  scope in `createRuntime`) onto `this.extensionsResult` — needed later by Slice 4's command catalog.

**Gate:** new integration test (temp `HOME` + two fixture projects with distinct
`.pi/settings.json` shell prefix and distinct `.pi/extensions/` command+skill): assert
per-project extension set, `/skill:` expansion, `ctx.cwd` via `pi.exec`, and settings isolation.

### 1b. Transition serialization mutex (P0#2)

In `electron/pi-host.ts`, add a promise-chain mutex and route **all mutating** methods through it:

```ts
private queue: Promise<unknown> = Promise.resolve();
private enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = this.queue.then(fn, fn);
  this.queue = p.catch(() => {});   // chain survives rejections
  return p;
}
```

Wrap (return `this.enqueue(() => …)`): `open`, `newSession`, `switchTo`, `fork`, `clone`,
`abort`, `prompt`, `steer`, `followUp`, `compact`, `setModel`, `setThinking`, `setSessionName`.
Read-only getters (`getState`, `getMessages`, `getStats`, `getModels`, `getTree`,
`getForkMessages`, `getThinkingLevels`) stay outside the mutex.

**Gate:** vitest with a fake `AgentSessionRuntime` injected via a new `HostOptions.modelRuntime?` /
`runtimeFactory?` override (see 1e) — assert `open(A) → open(B) → open(A)` executes
sequentially and emits exactly one final `ready` for A.

### 1c. Dialog rejection on session switch (P0#3)

In `electron/pi-host.ts` `start()`, immediately after `createAgentSessionRuntime`:

```ts
this.runtime.setBeforeSessionInvalidate(() => this.rejectAllUi(new Error("session switched")));
```

with `rejectAllUi` iterating `this.uiRequests`, deleting each entry and calling `reject`.
Renderer: `DialogHost` (`src/components/DialogHost.tsx`) currently renders only `dialogs[0]`;
add dismissal of stale dialogs on `dialog-dismiss` (already wired) — no renderer change required
beyond ensuring the reject path removes the dialog (it already filters by `id`).

**Gate:** integration test — open a session, raise a `select` dialog, switch session; assert the
pending promise rejects and the renderer dialog clears.

### 1d. sessionId-stamped events + renderer drop (P1#7 → replaces the epoch hack)

In `electron/pi-host.ts` `attachEvents`:

```ts
session.subscribe((event) => this.opts.onEvent({ ...event, sessionId: session.sessionId }));
```

Extract the renderer event filter into **`src/sessionLifecycle.ts`** (pure, testable — report 6):

```ts
export function shouldAcceptEvent(ev, ctx: { activeSessionId?: string | null }): boolean {
  if (ctx.activeSessionId == null) return true;          // idle/pre-first-session
  if (ev?.sessionId != null) return ev.sessionId === ctx.activeSessionId;
  return true;
}
```

`src/App.tsx`: track `activeSessionIdRef` from `status.state.sessionId` (or from the `ready`
status); drop events where `shouldAcceptEvent` is false. This kills the
`activeRunEpoch === null` hole (late `extension_ui_request` / `tool_execution_*` from the old
session after an idle switch) and makes the old epoch filter precise.

### 1e. cwd rollback on failed open (P1#6) + single wiring helper

In `electron/main.ts`:

- Add one helper used everywhere cwd changes (the host `onStatus`, `open-session`,
  `worktree-create`, `worktree-exit`):
  ```ts
  function applyCwd(cwd: string) { activeCwd = cwd; updateWorkflowsBridge(cwd); }
  ```
- `pideck:open-session` handler:
  ```ts
  ipcMain.handle("pideck:open-session", async (_e, opts) => {
    const prev = activeCwd;
    applyCwd(opts.cwd);
    try { return await getHost().open(opts); }
    catch (err) { applyCwd(prev); throw err; }   // runtime stays on old session; bridge restored
  });
  ```
- This also removes the duplicate `attachEvents`/`updateWorkflowsBridge` paths (single wiring point).

**Gate:** unit test on the extracted `applyCwd` behavior via an injected bridge factory; manual
"missing cwd → cancel dialog" check confirms the sidebar highlight + workflows bridge stay on the
old session.

### 1f. `getState()` honesty (P2#9, tiny + verified)

In `pi-host.ts` `getState()`: replace hardcoded fields with real session getters (all verified to
exist): `isCompacting: s.isCompacting`, `autoCompactionEnabled: s.autoCompactionEnabled`.

### 1g. Test harness + seams (report 6, non-behavioral)

- `package.json`: add `"test": "vitest run"` + `vitest` devDependency (Vite 6 config already present).
- Seams (all optional-param, default = current behavior):
  - `electron/sessions.ts`: `listSessions(root?)`, `readSessionMessages(path)` (root derived from `root ?? join(homedir(), ".pi", "agent", "sessions")`).
  - `electron/workflows.ts`: `WorkflowsBridgeOptions.runsDirs?` / `home?`.
  - `electron/pi-host.ts`: `HostOptions.modelRuntime?` / `runtimeFactory?` for fakes.
- `src/sessionLifecycle.ts` extraction (from 1d) is the first pure unit under test.

**Slice 1 exit gate:** `npm run typecheck && npm test`; manual matrix: rapid A→B→C switch,
TUI running concurrently while GUI edits the same session (warning path), worktree create/exit
while streaming (abort toast + persisted state).

---

## Slice 2 — chat render hot path (perf P0s)

**Files:** `src/components/items.tsx`, `electron/main.ts`, `src/lib/highlight.ts`,
`src/App.tsx`, `src/store.ts`.

### 2a. Memoization (`items.tsx`)
- `React.memo` the exported `UserMessage`, `AssistantMessage`, `ToolCard`, `SystemLine`
  (and `Composer` in `src/components/Composer.tsx`, `DiffView` in `items.tsx`).
- Extract `const TextBlock = memo(({ text }) => <Markdown text={text} />)` and use it in
  `AssistantMessage` — only the streaming block re-parses per delta.
- Reducer already preserves reference identity for untouched items (`items[i] = {...it, blocks}`),
  so this drops per-delta renders to O(1).

### 2b. Main-process event coalescing (`electron/main.ts`)
In the `onEvent` callback, buffer consecutive `message_update` events with the same
`contentIndex` + delta kind into one event (concatenate `delta`), and collapse
`tool_execution_update` to keep-last-output. Flush every ~33 ms and immediately on any
non-delta event (`agent_settled`, `message_end`, `tool_execution_*`, `extension_ui_request`).
Reducer is unchanged (`store.ts` `cur.text + (e.delta ?? "")` just appends).

### 2c. Shiki lazy-load (`src/lib/highlight.ts`)
Convert the two static imports (`shiki/core`, `shiki/engine/javascript`) into
`await import(...)` inside `load()`. Vite splits them out of the boot bundle; CodeBlock's 120 ms
debounce hides the async cost.

### 2d. Hydration epoch guard (`src/App.tsx`)
In both `hydrate()` and the `settledNonce` effect, capture `const epoch = epochRef.current` before
each `await`, and `return` after each await if `epoch !== epochRef.current`. Also tighten `send()`'s
liveReady waiter to resolve only on a `ready` carrying the requested `sessionPath` (or the current
epoch), not any `ready`.

### 2e. Settle-rebuild reconcile (`src/store.ts`)
In the `rebuild` case, after `messagesToItems`, reconcile by key **and content**: reuse an existing
item object when the same `key` exists and payload fields are equal (`blocks` text, tool
`status`/`output`/`details`, user `text`/`images`). This makes the first `rebuild` after each turn
a no-op for unchanged messages (no shiki re-run, no markdown re-parse).

**Gate:** parse counter on `Markdown` (total blocks → 1 per delta); `webContents.send` counter
(turn sends drop ~10–30×); `npm run build` bundle table (main chunk 588 KB → < ~320 KB with shiki
split); stale-hydrate `console.count` = 0 during rapid switches; highlight invocation counter
(all blocks → 0–2 per settle).

---

## Slice 3 — session index + sidebar (freshness, "not a mess")

**Files:** `electron/sessions.ts` (rewrite as `SessionIndex` + `SessionWatcher`),
`electron/main.ts`, `electron/preload.ts`, `src/bridge.ts`, `src/hooks/useSessions.ts` (new),
`src/components/Sidebar.tsx` (rewrite), `src/components/Hero.tsx`, `src/App.tsx`.

### 3a. `SessionIndex` + bounded reads
Keep `listSessions()` drop-in but back it with an in-memory cache + `version` counter.
Per file read head 64 KB (header + first user text) + tail 64 KB (last `session_info` name +
last-activity timestamp). `readSessionInfo` must `continue` (not `break`) on a corrupt/truncated
mid-buffer line, and tolerate a transient size-0 rewrite (dirty → re-read next tick).

**Wire contract (superset, wire-compatible — do not remove existing fields):**
```ts
interface SessionInfo {
  id: string; path: string; cwd: string;
  name?: string;            // tail-most session_info (rename)
  firstUserText?: string;   // head 64KB fallback title
  startedAt?: string;       // header timestamp
  lastActivity: number;     // max entry timestamp (fallback mtime) — the sort key
  mtime: number; size: number;      // stat signature for incremental invalidation
  messageCount?: number;
  isWorktree?: boolean;     // header.parentSession
  parentPath?: string;      // header.parentSession
  archived: boolean; archivedAt?: number;
}
// listSessions() now returns { groups: ProjectGroup[]; version: number }
```

**Migration/data contract:** no changes to `~/.pi/agent/sessions/**`. Archive state lives in a
**sidecar outside the sessions dir** — `~/.pi/agent/pideck/archive.json` →
`{ [sessionId]: { archivedAt: number; reason?: string } }` — so pi's own `listAll` never sees it.
Parse-fail on the sidecar → treat as empty.

### 3b. `SessionWatcher` + push channel
- `fs.watch(sessionsRoot, { recursive: true })` (macOS/Windows; Linux fallback = root + per-project
  dir watchers), 300–500 ms debounce; on flush, diff affected dirs by stat signature
  `(size, mtimeMs, ino)` and re-read only changed files; bump `version`; push.
- 30 s stat-only full rescan as a safety net.
- In-process touch: on host `agent_start`/`message_end`/`agent_settled`, `index.touch(activePath)` —
  re-read just that file's tail (~1 ms). Lets `App.tsx` drop `refreshSessions()` in the
  settle/branch handlers (L142, L290).
- New push channel (mirror `pideck:workflows-update`): `pideck:sessions-update` →
  `{ groups, version }`. Preload `onSessionsUpdate` + `src/bridge.ts` `onSessionsUpdate`.

### 3c. Rename / delete / archive IPC
- `pideck:session-rename {path,name}`: if path is active → `host.setSessionName()`; else append a
  valid `session_info` entry directly to the file (append-only, line-atomic, valid pi format).
- `pideck:session-delete {path}`: refuse active; `shell.trashItem(path)` (Electron, no `trash` dep).
- `pideck:session-archive {path, archived}`: sidecar + version bump.

### 3d. `useSessions()` + Sidebar redesign
- `useSessions()` = initial `listSessions()` + `onSessionsUpdate` subscription; flat `SessionMeta[]`
  + `version`. `Hero` shares it (removes its ad-hoc re-sort).
- Sidebar top→bottom: search field (`/` focuses, Esc clears, `useDeferredValue`), **Recents** (top 5
  by `lastActivity`), **Projects** (collapsible, sorted by newest; rows = name/first-user + timeAgo +
  ⚗ worktree badge + active ●; right-click `SessionMenu` rename/archive/delete), **Archived**
  (collapsed, derived `lastActivity` > 30 d + explicit pinning).
- `React.memo` row components + stable `path` keys; `content-visibility` on lists (escalate to
  `react-window` only if > ~500 rows measured).

**Gate:** unit parser-equivalence over the real corpus + synthetic (name at 14 MB tail, truncated
last line, size-0 blip, corrupt mid-line, missing header, worktree header); bench (cold ≤ ~30 ms
@100 files, incremental ≤ ~10 ms); integration via `PIDECK_SMOKE` + external `append/create/unlink/
truncate` asserting `pideck:sessions-update` ≤ 1 s with diff limited to touched files; IPC
round-trips (rename valid for pi `SessionManager.open`, delete → trash, archive → sidecar).

---

## Slice 4 — skills & slash commands in chat

**Files:** `electron/pi-host.ts` (`getCommands()`), `electron/main.ts`, `electron/preload.ts`,
`src/bridge.ts`, `src/components/Composer.tsx`, `src/components/CommandMenu.tsx` (new),
`src/commands.ts` (new, pure).

### 4a. Command catalog (main-process, zero new scanning)
`PiHost.getCommands()` merges, dedupes (extension > template > skill), and normalizes:
- `BUILTIN_SLASH_COMMANDS` (name/description/argumentHint),
- `this.bundles.get(currentCwd)?.resourceLoader.getPrompts().prompts` (`PromptTemplate.name/description/argumentHint`),
- `…getSkills().skills` (`Skill.name/description` → `/skill:${name}`),
- extension commands from the stashed `this.extensionsResult.extensions[].commands` keys.

**Wire contract (renderer never imports pi internals):**
```ts
interface CommandInfo {
  name: string;                 // "/name" or "/skill:name"
  description?: string;
  argumentHint?: string;        // PromptTemplate.argumentHint / BuiltinSlashCommand.argumentHint
  source: "builtin" | "extension" | "prompt" | "skill";
}
```
Do **not** reuse the SDK `SlashCommandInfo` on the wire — it lacks `argumentHint` and carries
`sourceInfo`. IPC: `pideck:get-commands`; renderer caches per-session (refetch on `ready`).

### 4b. Composer autocomplete
`Composer` renders `<CommandMenu>` when `/` is typed at token start (or after whitespace).
Pure ranking/insertion math in `src/commands.ts` (exact-prefix > token-prefix > substring > fuzzy;
cap ~30; `useDeferredValue`). `Tab`/`Enter` insert into the caret token; Esc closes.
**No new execution path** — text flows through the existing `onSend → bridge.prompt`.
Send rule (SDK semantics): if the message starts with an extension/skill command, send with
**no** `streamingBehavior` (extension commands execute immediately; `steer()`/`followUp()` throw on
them — `agent-session.js` `_throwIfExtensionCommand`).

**Gate:** unit tests on `commands.ts` ranking/insertion; integration — `/skill:` expansion resolves
the per-cwd skill (Slice 1 loader), extension command executes without chat pollution;
`/`-only send stays blocked.

---

## Slice 5 — command palette + Activity Center (Workflows / Subagents / Threads)

**Files:** `src/components/palette/*` (new), `src/components/activity/*` (new),
`src/hooks/useDismissibleDrawer.ts` + `useDismissablePopover.ts` + `useWorkflows.ts` (extracted),
`src/App.tsx`, `electron/workflows.ts`, `electron/threads.ts` (new), `electron/main.ts`,
`electron/preload.ts`, `src/bridge.ts`. Delete `src/components/WorkflowsPanel.tsx` +
`BranchPanel.tsx` (their `RunDetailView`/`AgentView`/tree content move verbatim).

### 5a. `useDismissibleDrawer` / `useDismissablePopover` extraction
Pure refactor — extract the duplicated drawer gesture (hysteresis, pointer-capture after intent,
rubber-band, velocity handoff) and popover outside-click/Escape boilerplate. No behavior change.

### 5b. Command palette (Cmd/Ctrl+K)
Modal (scrim, `z-50`, `useFluidAppear`), `role="dialog" aria-modal`, grouped flat results:
Actions / Threads (from `groups`) / Runs & agents / Commands (Slice 4 catalog). Enter on a command
inserts into the composer and focuses it — the palette never sends. React 19 `inert` on the app
while open; focus restore to `document.activeElement` on close.

### 5c. Activity Center (tabbed drawer)
Tabs:
- **Runs & Agents** — `WorkflowsPanel` content moved 1:1 (list → detail → agent; pause/resume/stop/
  delete with foreign-run read-only gate; logs; phases; LIVE badge; optimistic flips corrected by poll).
- **Tree** — `BranchPanel` content moved.
- **Threads** — read-only list from `electron/threads.ts`, polling `<cwd>/.pi/state/threads/*/
  thread.json` (stat `mtime+size+ino`, re-read on change, cross-check `revision`; ~1 s, accelerated by
  thread-tool events + `session_start`). Row → resume via existing `openSession(sessionFile)`.
- **Subagents** — event-driven in-memory registry (start ⇒ running; end ⇒ merge `RunDetails` from
  `tool_execution_end.result.details`); disk scan only to discover foreign-process runs
  (`<cwd>/.pi/state/subagents/runs/<runId>/provider-models.jsonl`; "stdout.log missing + recent
  route `at`" = in-flight). **Monitor-only** — no stop command exists; do not fabricate controls.

Header button → "activity" with a live dot (subscribe `onWorkflowsUpdate` once at App level).

### 5d. Workflows signature upgrade
`electron/workflows.ts` `scan()` signature: `name:mtimeMs:size` → `name:mtimeMs:size:ino` (add
`stat.ino`) so same-tick, equal-size atomic tmp+rename writes are distinguishable. Also skip the
1.5 s poll when no runs dir exists and when the panel is closed (`pideck:workflows:set-subscribed`).

**Gate:** unit tests on workflows `projectKey`/dedupe/corrupt-skip/control gating and threads
`revision` cross-check; jsdom smoke on panel controls (optimistic update + delete-on-resolve);
a11y checks (combobox semantics, focus trap, toast `aria-live`).

---

## Slice 6 — Electron hardening (small, independent)

**Files:** `electron/main.ts`, `index.html`.

1. `webPreferences.sandbox: false` → `true` (preload uses only `contextBridge`/`ipcRenderer`).
2. Deny-all `setWindowOpenHandler` + `will-navigate` block (external links already route through
   `openExternal`; Markdown intercepts clicks, this closes middle-click/`target=_blank`).
3. `pideck:open-external`: validate `https:`/`http:` only before `shell.openExternal`.
4. `pideck:get-session-messages`: resolve + verify containment under `~/.pi/agent/sessions` before
   `readSessionMessages`.
5. CSP in `index.html`: `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`
   (extract or nonce the theme-bootstrap inline script).
6. IPC sender validation: guard `event.senderFrame.url` against `file://` (prod) /
   `http://127.0.0.1:5173` (dev).

**Gate:** `npm run typecheck` + boot smoke; confirm external link, image attach, and Markdown
render still work.

---

## Slice 7 — perf + a11y polish (cosmetic, last)

**Files:** `src/styles.css`, `src/components/ChatView.tsx`, `src/components/Composer.tsx`,
`src/App.tsx`, dialog/toast components.

- `.chat-item { content-visibility: auto; contain-intrinsic-size: auto 140px; }` on the per-item
  wrapper (add a wrapper class in `ChatView`'s map); gate to `items.length > 60` if sticky scroll jank.
- `ChatView`: `useLayoutEffect` + `lastHeightRef` skip when `scrollHeight` unchanged.
- `Composer`: downscale attachments to max edge 1280 px + `toBlob("image/jpeg", 0.85)`, derive `url`
  from the same blob (kill the double base64 copy); keep `MAX_IMAGE_BYTES` pre-check.
- `React.lazy` + `Suspense` for `WorkflowsPanel`/`BranchPanel`/`WorktreeModal`/`CommandPalette`/
  `ActivityCenter` chunks.
- A11y: combobox semantics for composer/palette, focus trap + `aria-modal` on `DialogHost`, toast
  `aria-live="polite"`/`role="alert"`, drawer `role="dialog"` labels, keyboard nav in model/thinking
  pickers.

**Gate:** `npm run build` per-chunk table; scroll-frame layout/paint before/after with a ~150-message
transcript; heap snapshot with 3×8 MB attachments before/after.

---

## Cross-report conflicts resolved

- **Event filtering:** report 1's epoch guard (`activeRunEpoch`) is replaced by sessionId-stamped
  events (report 1 P1#7) + `shouldAcceptEvent`; the epoch is retained **only** as the hydrate/send
  anchor (report 2 P0#4). One mechanism per concern.
- **"Threads" in the UI:** report 5 maps its Threads tab to *sessions* (`groups`); report 4 documents
  the *threads extension* on-disk schema. Synthesis: the sidebar (Slice 3) owns sessions; the Activity
  Center's Threads tab (Slice 5) is backed by the threads extension's `thread.json` (report 4), since
  the durable objective names Threads as a distinct surface. Sessions-as-threads remains a v1 fallback
  when the threads extension is absent.
- **Command catalog type:** reuse SDK `BUILTIN_SLASH_COMMANDS`/`getPrompts`/`getSkills` to *build* the
  catalog, but define a new `CommandInfo` wire type (not SDK `SlashCommandInfo`) to carry
  `argumentHint`/`source`.

## Deferred / out-of-scope (explicitly)

- Full cross-process session file locking (TUI+GUI dual-write) — warning-level external-change
  detection only (report 1 P1#5); document the limitation.
- `@`-mention insertion path in the composer (report 5 §7) — additive follow-up.
- Virtualization library (`react-window`/`react-virtuoso`) — only if `content-visibility` proves
  insufficient at measured row counts.
- Deep full-text `pideck:session-search` (report 3 §5 "v2") — v1 search is renderer-side over the index.
- Subagent stop/cancel controls — the extension persists no manifest and exposes no stop command;
  monitor-only.
