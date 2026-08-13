# PiDeck Task Workspace Design

**Date:** 2026-08-13
**Status:** Approved
**Scope:** Application information architecture, context workspace, worker lifecycle, session tree, workflow graph, and the visual system needed to support them.

## 1. Product direction

PiDeck is a desktop workspace for supervising Pi sessions and related agent work. It is not a branded product page, an operator dashboard, or a generic chat application.

The redesign adopts structural principles verified from the Codex desktop product:

- stable project/task navigation;
- one focused conversation workspace;
- contextual inspection beside the conversation;
- task-scoped actions rather than a global feature toolbar;
- terse inline progress rather than prominent operation cards;
- long-running work visible in navigation;
- code, activity, and history treated as first-class work surfaces.

PiDeck will not copy Codex literally. It retains Pi-specific concepts: session branching, extension commands, workflows, persistent threads, bounded subagents, and Pi worktrees.

## 2. Shell and layout

The desktop shell has three possible regions:

1. **Navigation sidebar** — always visible unless explicitly toggled.
2. **Primary workspace** — the active Pi session or promoted live worker session.
3. **Context workspace** — conditionally visible for Activity, Tree, Changes, or an inspected related worker.

The context workspace is a real adjacent pane, not a fixed overlay or gesture-dismiss drawer. It is keyboard-toggleable, resizable, and closable. On narrow windows it replaces the primary workspace temporarily and provides a clear Back action.

### 2.1 Navigation sidebar

The sidebar is the application map. It contains:

- New session;
- Activity with a live count/state;
- Search/command palette entry;
- projects as expandable groups;
- sessions nested directly under projects;
- live/queued/error status beside relevant sessions;
- Settings and keyboard shortcut access at the bottom.

The project dropdown is removed. Activity, Tree, and Worktree are removed from the global header toolbar.

### 2.2 Primary workspace

The primary workspace always displays one session transcript. In normal use this is the selected parent Pi session. It contains:

- a compact task header with session name, project/path, execution context, and task-scoped actions;
- a focused transcript column;
- terse inline tool/progress entries;
- a task-aware composer.

The transcript does not use full-width turn dividers, author labels on every block, an “Operations” section card, or decorative operator-console language.

### 2.3 Context workspace

The context workspace has its own navigation stack. Example:

```text
Activity → Workflow run → Phase → Agent transcript
```

Back navigation changes only the context pane. Closing it never changes the active primary session.

Its top-level tabs are contextual rather than permanently global:

- **Activity** — workflows, persistent threads, and subagents;
- **Tree** — conversation ancestry for the active primary session;
- **Changes** — repository or last-turn changes when available.

## 3. Selection and promotion contract

Single-click inspection and intentional navigation are distinct actions.

### 3.1 Inspect in context

Selecting a workflow, persistent thread, workflow agent, or standalone subagent from Activity opens it in the context workspace. The primary session remains visible and active.

### 3.2 Open as session

A visible **Open as session** action promotes an eligible worker transcript into the primary workspace.

Promotion means:

- the worker becomes the active middle transcript;
- browser-style Back returns to the parent session;
- the context workspace can show the worker's workflow/run relationship;
- if the worker is live and steerable, the primary composer targets that worker;
- if the worker has ended, the transcript is read-only and no composer is shown.

Promotion must use the worker's actual transcript/session identity. PiDeck must never create a fake session by copying text into a new main session.

## 4. Worker behavior

### 4.1 Persistent threads

Persistent threads are multi-turn sessions by design.

When inspected in context they show:

- complete available transcript;
- goal, model, capability profile, status, files, commands, tests, and blocker;
- Steer, Follow up, Stop, and Open as session actions when supported by lifecycle state.

When opened as a session, their composer sends through the thread control channel, not the parent session's `prompt()` method.

Current verified extension behavior supports `send_input`/`/threads` control and preserves a real `sessionFile`. PiDeck should continue to use that extension-owned runtime rather than opening the file in the shared primary `PiHost`, because opening it there would replace or duplicate ownership of the live thread runtime.

A persistent thread may accept another turn after a prior turn becomes idle/completed because that is its explicit persistent-session contract. A thread that is closed/stopped is read-only.

### 4.2 Standalone subagents

Standalone subagents are bounded child processes.

Lifecycle:

```text
queued/running → completed | failed | cancelled | routing mismatch | timed out
```

Only a genuinely running subagent with a verified live control channel may expose a composer or steering controls. Once the child exits, it is permanently read-only. Opening an ended subagent never recreates or resumes it.

The currently verified `subagent` extension launches `pi --print --no-session`, closes stdin after the initial task, and persists stdout/stderr/route evidence only. It does **not** currently provide a live steering channel or durable Pi session. Therefore the existing standalone subagent UI must remain read-only unless the extension contract is upgraded to expose:

- live run identity;
- authoritative lifecycle state;
- a control method for steer/follow-up;
- live transcript events;
- explicit rejection after process termination.

PiDeck must not simulate steering by mutating logs, run JSON, or session files.

### 4.3 Workflow runs and agents

A workflow run is a container. Run-level controls include pause, resume, and stop when the owning runtime supports them.

Selecting a run opens:

- overview and goal;
- phase graph;
- current phase;
- task/agent list;
- timing, token, and cost data;
- run-level controls;
- errors, checks, and result.

Selecting an agent opens its transcript in the context pane. **Open as session** promotes it to the primary workspace.

Workflow agents may be messaged only while their exact worker session remains live. Completed, failed, cancelled, or skipped agents are read-only.

The verified workflow implementation currently creates an in-process `AgentSession`, persists `sessionId`, `sessionFile`, and transcript events, then disposes the session in `finally`. It does not retain a public per-agent control handle. To meet the approved steering behavior, the workflow extension must add an extension-owned control registry for active tasks and expose explicit steer/follow-up operations. PiDeck should call those operations through verified extension commands/tools. It must not open the same session file in the shared primary host while the workflow owns it.

Any control attempt must be validated against both the persisted task status and the live registry. Persisted `running` without a matching live runtime is stale and must fail closed with a clear read-only explanation.

## 5. Composer targeting

The composer is bound to a `ConversationTarget`, never implicitly to whatever transcript happens to be visible.

Conceptual targets:

```ts
type ConversationTarget =
  | { kind: "main-session"; sessionPath: string }
  | { kind: "thread"; threadId: string; lifecycle: "live" | "closed" }
  | { kind: "workflow-agent"; runId: string; taskId: string; lifecycle: "live" | "ended" }
  | { kind: "subagent"; runId: string; lifecycle: "live" | "ended" };
```

Rules:

- main-session sends use PiHost prompt/steer/follow-up;
- thread sends use the thread extension control channel;
- workflow-agent sends use the workflow extension's active-task control channel;
- subagent sends require a verified subagent control channel;
- ended targets expose no composer;
- control calls include target ID and expected lifecycle revision so stale UI cannot send to the wrong worker;
- changing selection during a send cannot retarget that send.

## 6. Activity information architecture

Activity is a sidebar destination and context-workspace master-detail tool.

Top-level filters:

- All;
- Workflows;
- Threads;
- Subagents.

Rows communicate state, title, parent session/project, age, and the smallest useful progress summary. Running items remain visible without animated visual noise.

Detail layouts are content-specific:

- workflow: run list + phase/agent detail;
- thread: transcript + metadata/actions;
- subagent: execution record + routing evidence/output;
- no repeated rounded cards around every field.

## 7. Session tree

The Session Tree represents only conversational ancestry for the active primary Pi session.

It is generated from the SDK/session manager tree and flattened for IPC. Source semantics:

- message entry IDs are nodes;
- `parentId` establishes ancestry;
- branch/fork relationships come from multiple children and SDK labels;
- active leaf identifies the current branch path;
- non-message metadata is not rendered as a conversational branch;
- tools and assistant messages within a turn are summarized beneath the initiating user prompt rather than becoming equal visual nodes.

The primary visible nodes are user turns. Each turn can show a bounded response summary, timestamp/status where available, branch count, and current-path state.

Interaction contract:

- single click previews that historical turn in the context workspace;
- clicking never mutates the session;
- **Fork from here** is a separate explicit action;
- the active path and alternate branches remain visually distinguishable without relying only on color;
- extremely deep sessions remain flat over IPC and are virtualized or incrementally rendered.

When a worker transcript is promoted into the primary workspace, Tree refers to that worker's own Pi session only if the worker exposes a genuine session tree. Workflow containment is never inserted into the conversation tree.

## 8. Workflow graph

Workflow phases and dependencies form a separate Workflow Graph derived from persisted workflow state.

```text
Research
├─ UI research
└─ Existing-system inspection
   ↓
Implementation
├─ Context workspace
└─ Control channels
   ↓
Verification
```

It communicates dependency and execution state. It does not invent conversational parent/child relationships and is never merged into Session Tree.

## 9. Worktree behavior

Worktree/local state is task context rather than a global header feature.

- creation begins from the new-session flow or a session-scoped menu;
- current context appears in the task header;
- handoff/return actions appear only when relevant;
- destructive discard remains explicitly confirmed;
- the original session remains preserved;
- session and Git operations remain transactional.

## 10. Visual system

The visual overhaul follows the new information architecture. It is not a color-only theme pass.

Principles:

- system-like desktop typography with a small, fixed type scale;
- readable 14–16 px primary interface text and at least 12 px metadata;
- one neutral surface hierarchy with high text contrast;
- restrained accent reserved for focus, links, and live state;
- compact 6–10 px radii rather than pervasive rounded cards;
- borders for structural division, shadows only for floating menus/modals;
- no gradients on primary controls;
- no glass, decorative tracked uppercase labels, marketing headings, pills for ordinary metadata, or “operator console” language;
- icon controls use one consistent stroke language and have labels/tooltips;
- hover, pressed, disabled, focus, loading, empty, and error states are systematic.

The UI must support light and dark themes from the same semantic token system. Theme customization may later expose accent/background/foreground/font preferences, but initial implementation should prioritize one excellent paired system over many presets.

## 11. State and navigation model

Renderer state separates:

- `primaryTarget` — the transcript in the primary workspace;
- `contextStack` — independent context-pane navigation;
- `contextTab` — Activity, Tree, or Changes;
- `contextWidth` and open/closed state;
- `navigationHistory` — parent/worker promotion history;
- live activity snapshots keyed by stable IDs and revisions.

Opening or closing context does not reset transcript state. Promoting a worker changes `primaryTarget` intentionally and records where to return.

## 12. Security and correctness

- Continue validating IDs before filesystem or command use.
- Do not concatenate untrusted messages into slash commands. Add structured IPC/control methods or safely encode arguments in extension-owned APIs.
- Require ownership checks for workflow and thread control.
- Fail closed when the owning extension runtime is absent.
- Do not let two runtimes concurrently own one writable session file.
- Keep session files append-only/read-only outside the SDK/owning extension.
- Stamp events and requests with target identity and revision; reject stale events.
- Bound transcript, log, image, and IPC payload sizes.
- Preserve project trust boundaries when inspecting or promoting worker sessions.

## 13. Accessibility and keyboard behavior

- Sidebar, primary workspace, and context workspace use predictable tab order and landmarks.
- All icon-only controls have accessible names.
- Context Back, Close, and promotion actions are keyboard accessible.
- `Cmd/Ctrl+B` toggles sidebar.
- `Cmd/Ctrl+K` opens search/commands.
- A dedicated shortcut toggles the context workspace.
- `Cmd/Ctrl+[` returns through promotion/context history as appropriate.
- Focus moves into an opened context detail and restores on close.
- Status is represented by text/icon as well as color.
- Resizing does not trap keyboard or pointer users.
- Reduced-motion disables nonessential transitions.

## 14. Empty, loading, and error states

- No session: restrained new-session state with recent projects, not a marketing hero.
- Empty Activity: explain how related work appears and preserve direct access to commands.
- Worker ended: show final status and remove composer entirely.
- Stale live record: state that the controlling runtime is unavailable and present read-only data.
- Missing transcript: show available metadata/log output rather than a blank pane.
- Context load failure: keep the parent session usable and offer retry.

## 15. Required extension/API work

### Renderer/Electron

- Replace fixed drawers with a split context workspace.
- Add explicit primary/context target state.
- Add transcript readers for thread and workflow-agent session files/events.
- Add structured worker-control IPC with lifecycle revision checks.
- Add tree-turn projection and preview APIs.
- Preserve existing project/session lifecycle, commands, dialogs, images, and worktrees.

### Threads extension

- Keep extension-owned runtime authority.
- Expose structured control rather than renderer-generated slash-command strings.
- Reject control for stopped/closed threads.
- Publish authoritative lifecycle revisions and transcript updates.

### Workflow extension

- Retain active worker handles in a run/task registry only while tasks are alive.
- Expose structured steer/follow-up operations keyed by run/task ID.
- Publish transcript events and lifecycle revisions.
- Reject control immediately after worker settlement/disposal.
- Preserve current structured-output contract and scheduler behavior.

### Subagent extension

- Either remain explicitly read-only in PiDeck, or add a deliberate interactive protocol with a live control channel and authoritative lifecycle.
- Never infer steerability from fresh log mtimes.
- Persist a terminal status record instead of guessing completion from stdout presence.

## 16. Testing and acceptance criteria

### Navigation and context

- Clicking related work opens it in context without changing the primary session.
- Open as session is explicit and reversible.
- Context Back and primary Back affect the correct independent history.
- Pane resizing, narrow-window replacement, and focus restoration work.

### Worker lifecycle

- Live persistent threads can be steered/followed up through their own runtime.
- Live workflow agents can be steered only through a verified active task handle.
- Ended subagents and workflow agents have no composer and reject all sends.
- Stale `running` records without runtimes are read-only.
- No message can be delivered to a different target after selection changes.

### Trees and graphs

- Session Tree reflects real parent IDs, branch points, and active leaf.
- Clicking a tree node is read-only; only explicit Fork mutates the session.
- Workflow dependencies render separately from Session Tree.
- A 1,500-level session remains safe across contextBridge.

### Visual quality

- No permanent toolbar duplicates sidebar/context navigation.
- No overlay drawers for Activity or Tree.
- No active body/metadata text below 12 px.
- No full-width user cards, gradient CTAs, glass surfaces, or stacked card grids for routine detail.
- Long transcripts, hundreds of sessions, light/dark themes, narrow windows, and all empty/loading/error states remain readable.

### Regression

- Existing prompts, images, slash commands, extension dialogs, model/thinking selection, compaction, workflows, threads, subagents, branching, and worktree behavior remain functional.
- Typecheck, unit tests, production build, security audit, and Electron smoke launch pass.

## 17. Out of scope

- Inventing a resumable session after a bounded subagent has ended.
- Merging workflow dependencies into conversation ancestry.
- Editing append-only session files directly.
- Replacing extension-owned live runtimes with renderer-managed model calls.
- Broad IDE features unrelated to PiDeck's existing capabilities.
