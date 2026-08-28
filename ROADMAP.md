# Babylon Roadmap

> Audited 2026-08-27 against the actual runtime. 1 of 16 features is genuinely Done; 11 are Partial; 4 are Foundation. 447 tests pass, `tsc` clean. Previous status language overstated integration; this version states what actually works.

## Integration priority

The next milestone is not more feature breadth. Most foundations already exist as pure, tested models. The priority is turning them into one coherent runtime:

1. Task/runtime ownership — make `src/tasks.ts` the object a real task executes through
2. Real process manager — actual spawn/PTY/kill replacing the ProcessPanel demo
3. Real LSP service — spawn, initialize, diagnose, restart, feed Pi
4. Pi-driven structured plans — agent proposes/pauses/resumes instead of manual editing
5. Completion contracts + hooks wired into the Pi lifecycle
6. Daemon becomes the actual PiHost owner; desktop connects through `DaemonClient`
7. Background executor governed by policies
8. Remote control started by the daemon and pointed at real state
9. Automation wired to the background executor
10. Browser preview driven by real tracked processes

Adjust this order where repository dependencies demand it; the dependency graph below argues for it.

## Definition of Done

A feature is Done only when:

1. The real Babylon runtime uses it.
2. It is connected to Pi where the feature requires agent execution.
3. The user can exercise the feature end-to-end through Babylon.
4. No fake, simulated, demo-only, or placeholder execution path is required.
5. UI state comes from the actual runtime, not manually constructed React state.
6. Failure states are real and observable.
7. Automated tests cover the integrated behavior, not just pure helpers.

A pure model is not Done. A protocol implementation is not Done. A UI panel is not Done. A server nothing starts is not Done. A daemon that does not own the runtime it claims is not Done. A scheduler with no executor is not Done. A terminal panel with a Simulate button is not Done.

Statuses: **DONE** (real, end-to-end, user-exercisable) · **PARTIAL** (meaningful working implementation exists; runtime wiring or major promised behavior remains) · **FOUNDATION** (model/protocol/helper infrastructure only) · **NOT STARTED**.

---

## Guiding principles

- Pi remains the agent engine. Babylon orchestrates, observes, constrains, and extends it rather than reimplementing the core agent loop.
- Agent state must be truthful. Never infer progress from animation or text when a concrete runtime state exists.
- Every long-running task should be resumable, inspectable, and interruptible.
- Parallel work should be isolated by default.
- The user should only be interrupted when their input is genuinely required.
- Security should be expressed as explicit execution policy, not vague warnings.
- New infrastructure must preserve Babylon's existing session history, rollback, worktree, extension, skill, and project-trust behavior.
- Keep the main interface dense, fast, keyboard-first, and free of unnecessary chrome.

---

## Phase 1: Execution Control

- [x] **DONE · 1. Agent permission system** — the one feature that is genuinely end-to-end. `electron/main.ts` creates a persisted `PermissionEngine` (rules on disk under userData, outside Pi session files); `electron/pi-host.ts` installs `installPermissionHook` so every Pi tool call is evaluated before execution, and `ManagedSubagents` routes spawns/follow-ups through the same controller. Modes supervised/auto/full_access with Full Access styled as dangerous in `PermissionsPanel`; allow once/session/always/deny flow through `ApprovalGate` and raise real attention items keyed to approval ids.

  Remaining polish, not gaps: risk classification (`classifyRisk`) is heuristic and could use adversarial tests; subagent gating covers managed subagents but not arbitrary extension-spawned processes.

## Phase 2: Coding Intelligence

- [ ] **PARTIAL · 2. LSP integration** — Electron owns project-scoped TypeScript, Python, Go, and Rust language-server processes. The service discovers source files, initializes stdio servers, synchronizes `didOpen`/`didChange`/`didSave`/`didClose`, normalizes diagnostics, retries bounded crashes, reports unavailable servers, and disposes children and watchers on project switch or app quit. The Problems panel shows real server state, PID, restart count, and grouped diagnostics. Newly introduced errors and warnings reach the active Pi session as bounded `babylon_diagnostics` context. A live Electron probe verified initial diagnostics, document version 2 after a file change, Pi delivery, project-switch cleanup, and app-quit cleanup.

  Missing integration: daemon ownership so language servers can survive desktop closure, broader workspace-folder/configuration behavior for monorepos, and editor actions such as hover, rename, and code actions. Linux fallback watching also needs dynamic directory discovery beyond the initially observed directories.

## Phase 3: Runtime Workspace

- [ ] **FOUNDATION · 3. Structured plans** — `src/plans.ts` is a complete pure model (steps, deps, approve/reject/reorder, monotonic seq, derived status) and `PlansPanel.tsx` lets the user create plans and manually flip step states. Pi neither proposes plans nor pauses for approval; step status never moves from execution; plan decisions never reach the agent.

  Missing integration: a Pi tool or convention for plan proposal, an approval gate that pauses the agent, decision delivery back to the session, and automatic step-status updates from tool activity.

- [ ] **PARTIAL · 4. Agent-aware terminal** — Electron now owns a real `ProcessManager`. `ProcessPanel.tsx` can spawn project commands, display bounded stdout/stderr, PID, cwd, detected output ports, exit state/code, and kill the real process group. Renderer and diagnostics state comes from process snapshots over IPC rather than fabricated React state. Inputs are validated at the main-process boundary and live children are disposed on app quit.

  Missing integration: PTY/stdin support for interactive commands, restart, listening-socket probing, output references/tools for Pi, agent-created process registration, and eventual daemon ownership so processes survive desktop closure.

- [ ] **FOUNDATION · 5. Browser preview** — `PreviewPanel.tsx` calls `detectServerFromCommand("pnpm dev")`, a hardcoded string-to-port guess; there is no network probing, no console/page-error capture, no screenshot, no element inspection, and none of the promised `preview_*` agent tools exist anywhere.

  Missing integration: detection from real tracked processes (depends on Feature 4), an embedded webview with navigation/reload/console capture, and Pi tools backed by that webview.

## Phase 4: Parallel Work

- [ ] **PARTIAL · 6. Task-owned worktrees** — Electron now owns task lifecycle via `TaskManager` (`src/tasks.ts` registry plus `electron/process-manager.ts`). `pideck:worktree-create` provisions one running task that owns the cloned Pi session, optional git branch/worktree, and later processes; `pideck:task-spawn` / task-stamped `process-spawn` validates cwd, stamps `owner`/`ownerSession`, and records `terminalIds`; `pideck:worktree-exit` goes through `TaskManager.exit` which refuses discard of a dirty worktree, kills owned processes before git/file cleanup, and rejects concurrent exits. A live Electron probe verified session-only create → process ownership → keep (paused + killed) → session reopen (running) → discard (removed). Renderer can list/get tasks and subscribe to `pideck:task-update`.

  Missing integration: daemon persistence so tasks survive app quit and worktree recovery on restart, plus attachment of preview/diff/checkpoints to the task id (still panel-local).

- [ ] **PARTIAL · 7. Structured subagent graph** — real subagents exist and work: `ManagedSubagents` spawns bounded and persistent agents, gates them through permissions, relays parent messages, and surfaces activity in the transcript. `src/subagent-graph.ts` (parent/child tree, goals, results, summaries) is imported by nothing and represents none of those real agents.

  Missing integration: project live `ManagedSubagentRecord`s into the graph (or replace the model with a view over the real records), keep parent/child/status/model/result truthful from runtime events, and render the tree.

- [ ] **PARTIAL · 8. Model roles** — the title role is real: `pi-host.ts` resolves `settings.titleModel`/`titleReasoning` and generates session titles with the cheap model. Recaps merge stored recaps. `src/model-roles.ts` (planner/scout/reviewer/recap/title resolution, budgets, fallbacks) is imported only by the never-connected `runtime.ts`; roles other than title influence nothing.

  Missing integration: route recap/review/scout-style calls through role resolution, enforce budgets/fallback in the real invocation path, and show which model produced each artifact.

## Phase 5: Attention and Completion

- [ ] **PARTIAL · 9. Attention inbox** — real source: permission requests (raised on `onApprovalRequested`, cleared when the approval resolves). Synthetic source: automation failures from the placeholder executor. None of the other promised sources exist: no agent questions, blocked tasks, merge conflicts, missing credentials, environment failures, or review requests feed it.

  Missing integration: emit attention from real conditions — workflow/worktree conflicts, failed sessions, contract failures once contracts gate real work, review requests — and resolve them when the condition clears.

- [ ] **PARTIAL · 10. Completion contracts** — `src/completion-contracts.ts` evaluator is real and now gates task completion: `pideck:task-complete` checks required checks, fails closed on missing results, blocks `completed` and raises `failed_task` attention with the contract title/detail; passing checks marks the task `completed`. `automation-runner` also uses the same evaluator. Live Electron probe verified a task with a typecheck/tests contract failing then passing.

  Missing integration: automatic check execution (typecheck/tests/lint/diagnostics) rather than supplied `CheckResult`s, and surfacing unsatisfied checks for a repair pass.

- [ ] **PARTIAL · 11. Hook system** — registry plus `src/hook-dispatcher.ts` (timeout via `Promise.race`, `AbortSignal`, error isolation, block short-circuit, `rewriteArgs` threading, metadata collection) wired into `pre_tool_use` via `installAgentGuards` (composed with the permission hook) and `post_tool_use`/`before_stop` via `HookManager`. `pideck:hooks-*` IPC and `pideck:hooks-update` exist. Live probe verified `before_stop` block → `blocked_task` attention, then contract fail → `failed_task` attention, then pass → `completed`.

  Missing integration: richer `rewrite_args`/`attach_metadata` actions, `attention_required` dispatch, and hook persistence for the future daemon owner.

## Phase 6: Control Plane

- [ ] **PARTIAL · 12. Babylon daemon** — the transport story is real and tested: framed protocol, `daemon-server.ts` (multi-client, atomic persistence, event broadcast, policy ticks), `daemon-client.ts` (correlated requests, reconnect, queued calls), `daemon/main.ts` standalone entry, and Electron can spawn it when `daemon.enabled` is set. The extraction itself has not happened: Electron still creates and owns `PiHost` directly; the daemon holds an empty parallel `RuntimeState`; nothing ever connects a `DaemonClient`; closing the app still takes agent work down with it.

  Missing integration: move PiHost/session/approval/process ownership into the daemon, make the desktop a thin client over `DaemonClient`, prove close-and-reopen reconnects to live state, and delete the competing in-app sources of truth.

- [ ] **PARTIAL · 13. Background execution policies** — `canRunInBackground` gating is real wherever the tick runs (daemon timer, App scheduler loop): mode/battery/sleep/concurrency/cost/per-project checks produce truthful block reasons. What the policies govern is not: the only schedulable work is the placeholder executor that always fails. No real background agent execution exists to pause or resume.

  Missing integration: depends on Feature 12 — background agent tasks owned by the daemon, concurrency enforced against real agents, battery/sleep signals from the OS, resume-after-wake.

## Phase 7: Remote Control

- [ ] **PARTIAL · 14. Remote and mobile control** — `remote-server.ts` is a complete, socket-tested implementation: token auth (timing-safe, constant-time fallback), per-request scope enforcement, mid-session revocation, scoped attention push, injected handlers. It is never started by any process. `DevicesPanel.tsx` pairs devices into local React state that no server reads. No remote client exists.

  Missing integration: the daemon starts the remote server over its real state (depends on Feature 12), pairing persists beyond React, and at least one real client exercises view/approve/stop end-to-end.

## Phase 8: Automation

- [ ] **PARTIAL · 15. Scheduled and conditional tasks** — the machinery is real: trigger evaluation (interval/daily/file/branch watch), policy-gated selection, history recording, attention on failure, a scheduler loop running in App on a 30s interval, and a full creation/toggle/history UI. The executor is not: `run: () => ({ success: false, error: "no automation executor configured in this build" })`. Every run is a recorded synthetic failure.

  Missing integration: an executor that starts a real Babylon/Pi task (depends on Features 12/13), permission rules applied to it, completion contracts applied to it, and independence from the desktop window.

## Cross-cutting infrastructure

- [ ] **PARTIAL · Event model / stable ownership / observability** — the catalog, log, projection, ownership stamps, and aggregate diagnostics are implemented and tested. Real runtime coverage is a subset: `turn.started/completed` and `tool.started/completed` are mapped from genuine Pi agent events in App; the other twelve event types are defined but never emitted by anything. Diagnostics reports ownership/event coverage honestly rather than hiding the gap.

  Missing integration: emit the remaining types from real subsystem boundaries as features land (approvals, processes, plans, tasks, attention, checkpoints), and keep the coverage report truthful in the meantime.

---

## Dependencies

- Process manager (4) unlocks browser preview (5) and gives tasks something to own (6).
- Task primitive (6) is the unit that plans (3), contracts (10), hooks (11), and automation (15) should attach to.
- Daemon ownership (12) is the prerequisite for true background execution (13), remote control (14), and window-independent automation (15).
- Hooks (11) + contracts (10) need the task/agent lifecycle from (6)/(12) to gate anything real.
- LSP (2) is independent and can proceed in parallel once a service home (main process or daemon) is chosen.

## Recommended order

1. Real process manager (main-process spawn/PTY/kill/output) — replaces the demo, feeds preview and tasks.
2. Task primitive owning session + worktree + processes — the execution unit everything else attaches to.
3. LSP service with the Pi diagnostics feedback loop.
4. Pi-driven structured plans with approval pausing.
5. Hook runner + completion contracts gating the task lifecycle.
6. Daemon becomes PiHost owner; desktop becomes a client.
7. Background executor under policies; automation points at it.
8. Remote server started by the daemon against real state.
9. Browser preview driven by tracked processes and exposed to Pi.
10. Emit remaining event types as each subsystem lands.

---

## Explicit non-goals for now

Do not prioritize these ahead of the roadmap above:

- More decorative chat UI
- Replacing Pi's agent loop
- Replacing Pi's session format
- A built-in source-code editor competing with existing editors
- Cloud synchronization before the local control plane is robust
- Generic plugin marketplace infrastructure
- Multi-user collaboration
- Enterprise RBAC
- Container or Kubernetes orchestration
- Arbitrary provider abstraction before Babylon's Pi experience is complete

---

## North Star

Babylon should become the place where the user controls software-engineering agents, not another place where they manually manipulate code.

The desktop experience should eventually make it possible to:

- Describe a task.
- Approve or edit the plan when necessary.
- Let isolated agents execute in parallel.
- Only be interrupted for real decisions or consequential actions.
- Review precise diffs, diagnostics, runtime state, and completion checks.
- Roll back, branch, merge, or continue from any meaningful point.
- Leave the app and trust that Babylon still knows exactly what every agent is doing.
