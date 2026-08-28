# Babylon Roadmap

> Audited 2026-08-27 against the actual runtime. 1 of 16 features is genuinely Done; 10 are Partial; 5 are Foundation. 426 tests pass, `tsc` clean. Previous status language overstated integration; this version states what actually works.

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

- [ ] **FOUNDATION · 2. LSP integration** — `electron/lsp.ts` implements Content-Length framing, `encodeLspMessage`/`decodeLspMessages`, and diagnostic mapping, with tests. Nothing imports it. No server is ever spawned, initialized, or restarted; no document sync; no project association; no diagnostics in the UI; no feedback loop to Pi.

  Missing integration: a project-scoped LSP service in the main process (spawn → initialize → didOpen/didChange/didSave → publishDiagnostics → crash restart), a workspace diagnostics surface, and a post-edit hook that returns new relevant diagnostics to the active Pi session. Narrow the promised capabilities (hover/rename/code actions) until each has a live server behind it.

## Phase 3: Runtime Workspace

- [ ] **FOUNDATION · 3. Structured plans** — `src/plans.ts` is a complete pure model (steps, deps, approve/reject/reorder, monotonic seq, derived status) and `PlansPanel.tsx` lets the user create plans and manually flip step states. Pi neither proposes plans nor pauses for approval; step status never moves from execution; plan decisions never reach the agent.

  Missing integration: a Pi tool or convention for plan proposal, an approval gate that pauses the agent, decision delivery back to the session, and automatic step-status updates from tool activity.

- [ ] **PARTIAL · 4. Agent-aware terminal** — Electron now owns a real `ProcessManager`. `ProcessPanel.tsx` can spawn project commands, display bounded stdout/stderr, PID, cwd, detected output ports, exit state/code, and kill the real process group. Renderer and diagnostics state comes from process snapshots over IPC rather than fabricated React state. Inputs are validated at the main-process boundary and live children are disposed on app quit.

  Missing integration: PTY/stdin support for interactive commands, restart, listening-socket probing, output references/tools for Pi, agent-created process registration, and eventual daemon ownership so processes survive desktop closure.

- [ ] **FOUNDATION · 5. Browser preview** — `PreviewPanel.tsx` calls `detectServerFromCommand("pnpm dev")`, a hardcoded string-to-port guess; there is no network probing, no console/page-error capture, no screenshot, no element inspection, and none of the promised `preview_*` agent tools exist anywhere.

  Missing integration: detection from real tracked processes (depends on Feature 4), an embedded webview with navigation/reload/console capture, and Pi tools backed by that webview.

## Phase 4: Parallel Work

- [ ] **PARTIAL · 6. Task-owned worktrees** — real Git worktrees exist and are user-exercisable (`pideck:worktree-create/info`, BranchPanel, WorktreeBanner in `electron/main.ts`). What does not exist: the Task primitive. `src/tasks.ts` is imported by nothing outside its own tests and the never-connected `runtime.ts`; no execution path creates a task, links a session/branch/worktree to it, or promotes/merges through it.

  Missing integration: make the task the unit of execution — creating a task provisions session + branch + worktree, its terminals/preview/diff/checkpoints hang off the task id, and removal guards dirty worktrees at the runtime layer, not just in the pure model.

- [ ] **PARTIAL · 7. Structured subagent graph** — real subagents exist and work: `ManagedSubagents` spawns bounded and persistent agents, gates them through permissions, relays parent messages, and surfaces activity in the transcript. `src/subagent-graph.ts` (parent/child tree, goals, results, summaries) is imported by nothing and represents none of those real agents.

  Missing integration: project live `ManagedSubagentRecord`s into the graph (or replace the model with a view over the real records), keep parent/child/status/model/result truthful from runtime events, and render the tree.

- [ ] **PARTIAL · 8. Model roles** — the title role is real: `pi-host.ts` resolves `settings.titleModel`/`titleReasoning` and generates session titles with the cheap model. Recaps merge stored recaps. `src/model-roles.ts` (planner/scout/reviewer/recap/title resolution, budgets, fallbacks) is imported only by the never-connected `runtime.ts`; roles other than title influence nothing.

  Missing integration: route recap/review/scout-style calls through role resolution, enforce budgets/fallback in the real invocation path, and show which model produced each artifact.

## Phase 5: Attention and Completion

- [ ] **PARTIAL · 9. Attention inbox** — real source: permission requests (raised on `onApprovalRequested`, cleared when the approval resolves). Synthetic source: automation failures from the placeholder executor. None of the other promised sources exist: no agent questions, blocked tasks, merge conflicts, missing credentials, environment failures, or review requests feed it.

  Missing integration: emit attention from real conditions — workflow/worktree conflicts, failed sessions, contract failures once contracts gate real work, review requests — and resolve them when the condition clears.

- [ ] **FOUNDATION · 10. Completion contracts** — `src/completion-contracts.ts` evaluates required vs optional checks; `automation-runner` applies it, but only to the placeholder executor's synthetic runs. No real task or agent lifecycle consults a contract; "agent finished" and "contract passed" are never distinguished in a real flow.

  Missing integration: hook contract evaluation into before_stop/task completion (depends on Features 11 and 6), surface unsatisfied checks, and drive repair passes.

- [ ] **FOUNDATION · 11. Hook system** — `src/hooks.ts` is a registry (pre/post_tool_use, before_stop, attention_required slots, ordering, timeout fields) with copy-on-insert semantics. There is no dispatcher: nothing executes hooks, enforces timeouts, isolates failures, or can block/rewrite a tool call. Pi's real pre-tool interception exists separately inside the permission hook.

  Missing integration: a hook runner with timeouts and error isolation, wired to the same lifecycle points the permission hook uses, plus before_stop tied to completion contracts.

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
