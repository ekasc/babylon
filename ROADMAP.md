# Babylon Roadmap

> Last updated: 2026-08-20 · 15 of 16 features done, 1 partial. 338 tests on `main` (`tsc` clean).

Babylon is a secure desktop workspace for the Pi coding agent. The next phase should focus on execution infrastructure rather than adding more chat surface area.

The goal is to make Babylon capable of safely running long-lived, parallel software-engineering work with strong visibility, isolation, recovery, and user control.

## Progress at a glance

| Phase | Feature | Status | Evidence |
|-------|---------|--------|----------|
| 1 · Execution Control | 1. Agent permission system | **Done** | `electron/permissions.ts` + `permission-agent.ts` + `permission-hook.ts` · PR #2 |
|  | 2. Automatic risk review | **Done** | `classifyRisk` / heuristic reviewer in `permissions.ts`, wired through `permission-hook.ts` · PR #2 |
| 2 · Coding Intelligence | 3. LSP integration | **Done** | `electron/lsp.ts` wire protocol · PR #3 |
|  | 4. Structured plans | **Done** | `src/plans.ts` · PR #3 |
| 3 · Runtime Workspace | 5. Agent-aware terminal | **Done** | `src/process-model.ts` · PR #4 |
|  | 6. Browser preview | **Done** | `src/preview-model.ts` · PR #4 |
| 4 · Parallel Work | 7. Task-owned worktrees | **Done** | `src/tasks.ts` · PR #5 |
|  | 8. Structured subagent graph | **Done** | `src/subagent-graph.ts` · PR #15 |
|  | 9. Model roles | **Done** | `src/model-roles.ts` · PR #5 |
| 5 · Attention and Completion | 10. Attention inbox | **Done** | `src/attention.ts` + `src/components/AttentionPanel.tsx` wired to approvals · PR #6, #13 |
|  | 11. Completion contracts | **Done** | `src/completion-contracts.ts` · PR #6 |
|  | 12. Hook system | **Done** | `src/hooks.ts` · PR #7 |
| 6 · Control Plane | 13. Extract runtime into Babylon daemon | **Done** | `src/daemon-transport.ts` + `daemon-server.ts` + `daemon-client.ts` + `daemon/main.ts` (framed socket transport, persistence, reconnect, standalone process) · Phase 6 PR |
|  | 14. Background execution policies | **Done** | `src/background-policy.ts` + `src/scheduler.ts` + `src/background-controller.ts` enforced by the daemon tick loop · Phase 6 PR |
| 7 · Remote Control | 15. Remote and mobile control | **Done** | `src/device-pairing.ts` + `src/remote-auth.ts` + `src/remote-actions.ts` + `src/remote-server.ts` (token auth, scoped actions, attention push) + `DevicesPanel.tsx` · Phase 7 PR |
| 8 · Automation | 16. Scheduled and conditional tasks | **Partial** | `src/automation.ts` (#11), `src/scheduler.ts` (#12), `src/automation-runner.ts` (#16); automation UI still to do |
| Cross-cutting | Event model / stable ownership / observability | **Partial** | Stable ids and `makeId`, protocol envelopes with stable ids; full event sourcing and diagnostics surface still to do |

Check the box when the feature has a pure, tested model merged to `main` and, where the roadmap requires it, a desktop surface. Partial means the model exists but the daemon/process/transport/UI wiring is still open.

---

## Guiding principles

- Pi remains the agent engine. Babylon should orchestrate, observe, constrain, and extend it rather than reimplementing the core agent loop.
- Agent state must be truthful. Never infer progress from animation or text when a concrete runtime state exists.
- Every long-running task should be resumable, inspectable, and interruptible.
- Parallel work should be isolated by default.
- The user should only be interrupted when their input is genuinely required.
- Security should be expressed as explicit execution policy, not vague warnings.
- New infrastructure must preserve Babylon's existing session history, rollback, worktree, extension, skill, and project-trust behavior.
- Keep the main interface dense, fast, keyboard-first, and free of unnecessary chrome.

---

## Phase 1: Execution Control

- [x] **1. Agent permission system** — Babylon-owned permission layer around agent actions. Modes `supervised` / `auto` / `full_access`; per-category policies; persistent + session rules; approval UI with allow once / session / always / deny. Done in `electron/permissions.ts`, `permission-agent.ts`, `permission-hook.ts`, `ApprovalGate.tsx`, PR #2.

  Execution modes

  - Supervised: ask before commands, writes, external access, and other consequential actions.
  - Auto: routine actions run automatically, risky or uncertain actions require approval.
  - Full Access: run without interactive approval prompts.

  Approval actions — each request supports allow once, allow for session, always allow matching actions, deny.

  Policy categories — file reads, file writes inside/outside workspace, shell commands, destructive shell commands, network access, git commit, git push, package installation, process spawning, privileged commands.

  Requirements — policies are evaluated before execution; persistent rules are stored outside Pi session files; session-only rules disappear with the session; approval state is visible in the transcript and Activity surfaces; rules are editable in Settings; Full Access is visibly distinct from safer modes.

- [x] **2. Automatic risk review** — secondary review when no static rule matches. Done as `classifyRisk` heuristic in `permissions.ts` wired through `permission-hook.ts`, PR #2. Explicit deny is never overridden.

  Flow: agent action → static policy → clearly allowed? yes → execute / no → risk review → low risk → execute / high or uncertain risk → ask user.

  Reviewer considers command intent, affected paths, destructive flags, external network access, privilege escalation, repository state, current project boundary.

## Phase 2: Coding Intelligence

- [x] **3. LSP integration** — language intelligence service Babylon can expose to Pi. Done in `electron/lsp.ts` (header parsing, `encodeLspMessage` / `decodeLspMessages`, `mapDiagnostics`), PR #3.

  Initial capabilities: diagnostics, go to definition, find references, hover, rename, code actions. Agent feedback loop: after file edit → language server runs diagnostics → new errors/warnings collected → relevant diagnostics returned to active agent → agent can fix without waiting for user.

  Requirements: diagnostics diff-aware where possible; avoid flooding agent with unchanged diagnostics; language servers project-scoped; server crashes must not destabilize main session; surface current diagnostics in workspace UI.

- [x] **4. Structured plans** — plans as first-class Babylon state rather than plain Markdown. Done in `src/plans.ts` (monotonic `nextStepSeq`, `reconcile`, `deriveStatus`), PR #3.

  A plan contains ordered steps, step status, optional dependencies, affected areas/files when known, approval state, execution progress. Actions: edit, approve, reject, reorder, add/remove steps, execute one, execute all, pause after current step. States: proposed, approved, running, paused, blocked, completed, cancelled. Agent can propose a plan and stop before implementation when approval is required.

## Phase 3: Runtime Workspace

- [x] **5. Agent-aware terminal** — first-class terminal and process manager. Done in `src/process-model.ts` + `ProcessPanel.tsx`, PR #4.

  Each tracked process includes command, cwd, owning session/agent, PID, start time, exit status, detected ports, current state. Example `TERMINALS` list with dev server :5173, tests, shell. Requirements: interactive PTY support, multiple terminals per task, kill/restart, agent-created processes appear automatically, exited processes remain in history, output can be referenced by agent, ownership explicit.

- [x] **6. Browser preview** — integrated preview surface for local web apps. Done in `src/preview-model.ts` (`detectServerFromCommand`) + `PreviewPanel.tsx`, PR #4.

  Automatic behavior: `pnpm dev` → `localhost:5173` detected → preview available. Capabilities: navigate, reload, open externally, inspect console output, capture screenshot, select elements, report page errors, basic agent-driven interaction. Agent tools: `preview_open`, `preview_navigate`, `preview_click`, `preview_type`, `preview_screenshot`, `preview_console`, `preview_inspect`.

## Phase 4: Parallel Work

- [x] **7. Task-owned worktrees** — worktrees as task execution primitive. Done in `src/tasks.ts` (addTask refuses overwrite, `isRemovable` guards dirty worktrees), PR #5.

  A task may own Pi session, git branch, git worktree, terminals, preview, diff, checkpoints. Behavior: parallel task can auto-create worktree; worktree/branch names deterministic but editable; removing a task must not silently destroy uncommitted changes; task state survives restart; completed work can be promoted/merged.

- [x] **8. Structured subagent graph** — clearer hierarchy of work. Done in `src/subagent-graph.ts` (PR #15).

  Example:

  ```
  Main Agent
  Research
  ├── ✓ Database scout
  ├── ✓ API scout
  └── ● Test scout
  Implementation
  ├── ● Backend worker
  └── ○ Frontend worker
  Review
  └── ○ Reviewer
  ```

  Requirements: parent/child relationships explicit; each agent has goal, state, model, owner, and result; subagent output defaults to summaries rather than flooding parent transcript; full transcripts remain inspectable; agents may run in isolated worktrees; bounded and persistent agents remain distinct concepts.

- [x] **9. Model roles** — explicit roles for cheaper background work. Done in `src/model-roles.ts` (`mergeRoleConfig` filters explicit undefined, `setRole` merges), PR #5.

  Suggested roles: primary, planner, scout, reviewer, recap, title. Each role can configure provider/model, reasoning level, token budget, fallback model. Requirements: roles optional; primary session model remains independent; background roles must not silently consume expensive models; show which model performed summaries/reviews/plans.

## Phase 5: Attention and Completion

- [x] **10. Attention inbox** — one global place for everything that genuinely needs the user. Done in `src/attention.ts` (add no-overwrite, `removeAttention` hard delete, list unresolved newest-first) + `src/components/AttentionPanel.tsx` wired to approval events (PR #6, #13).

  Attention types: permission request, agent question, failed task, blocked task, merge conflict, missing credential, environment failure, review requested. Requirements: works across projects/sessions; items disappear when resolved; user can jump to originating context; background agents do not require the user to keep their chat open.

- [x] **11. Completion contracts** — define what must be true before Babylon considers a task complete. Done in `src/completion-contracts.ts` (required vs optional checks, `addCheck` dedupe, `removeCheck` no-op safe), PR #6.

  Example definition of done: typecheck, unit tests, lint, no new diagnostics, browser smoke test, diff reviewed. Checks: command exits successfully, tests pass, typecheck passes, lint passes, no new LSP errors, no unresolved TODO markers, working tree state matches policy, browser smoke test passes, review agent approves. Behavior: distinguish agent finished from completion contract passed; the second is the trustworthy state.

- [x] **12. Hook system** — small, stable Babylon hook lifecycle. Done in `src/hooks.ts` (pre/post_tool_use, before_stop, attention_required, copy-on-insert, stable order array, `timeoutMs` validation), PR #7.

  Examples: `pre_tool_use` can block, rewrite args, require approval, attach metadata; `post_tool_use` runs diagnostics, updates process/git state; `before_stop` verifies contract, requires tests, requests repair pass; `attention_required` creates inbox item or notifies remote client. Hooks must have strict timeouts and must not deadlock the agent runtime.

## Phase 6: Control Plane

- [x] **13. Extract the runtime into a Babylon daemon** — move long-lived orchestration out of the Electron application process. Done: `src/daemon-transport.ts` (newline frame codec), `src/daemon-server.ts` (socket server owning runtime + schedule + history + policy, atomic snapshot persistence, event broadcast, policy tick loop), `src/daemon-client.ts` (typed request/response, event subscription, reconnect with capped backoff, queued requests), `daemon/main.ts` standalone entry built to `dist-daemon/main.mjs`, and settings-gated detached spawn in `electron/main.ts` (`daemon.enabled`). Phase 6 PR.

  Target architecture: Babylon Daemon owns Pi host lifecycle, session/task/approval/terminal/worktree/attention/background execution/persistence; desktop owns rendering, keyboard interaction, dialogs, notifications, previews, user input; they talk over a typed local protocol. Requirements: closing GUI must not kill background agents unless configured (detached child, never killed on quit); reopening reconnects (client auto-reconnect); protocol events carry stable task/session/tool ids (versioned envelopes); runtime state remains authoritative outside React.

- [x] **14. Background execution policies** — explicit policies for background work once the daemon exists. Done: `src/background-policy.ts` (never / while_plugged_in / always + pauseOnBattery/pauseOnSleep/maxConcurrent/maxCost/perProject) gated through `src/scheduler.ts`, composed into the pure `src/background-controller.ts` tick, and enforced by the daemon server's policy loop (`policyTickMs`, `envSignals`, `runAutomation` injectable; `policy.updated` over the protocol). Blocked tasks are reported with reasons.

  Examples: background execution never / while plugged in / always; additional controls pause on battery, pause on sleep, resume after wake, maximum concurrent agents, maximum background model cost, per-project background permission.

## Phase 7: Remote Control

- [x] **15. Remote and mobile control** — inspect and control active Babylon tasks from another trusted device. Done: `src/device-pairing.ts` (token-hash grants, `pairDevice` validation), `src/remote-auth.ts` (sha256 hashing, timing-safe verify), `src/remote-actions.ts` (one action, one scope), `src/remote-server.ts` (token auth over the framed transport, per-request scope checks, mid-session revocation, attention push to `receive_attention` devices, last-seen tracking), and the `DevicesPanel` pairing surface (token shown once, scope picker, revoke). Phase 7 PR.

  Initial remote scope intentionally small: view active tasks, view current agent state, receive attention notifications, approve/deny actions, answer agent questions, stop/pause/resume tasks, view concise diffs and completion state. Do not recreate the entire desktop workspace on mobile. Pairing uses explicit device pairing with revocable grants; each device has identity, authorization scope, creation time, last-seen time, revoke control.

## Phase 8: Automation

- [ ] **16. Scheduled and conditional tasks** — allow Babylon tasks to run without an open foreground session after background execution is reliable. Partially done: `src/automation.ts` trigger model (#11), `src/scheduler.ts` due-task evaluation (#12), and `src/automation-runner.ts` executor with history and inbox (#16). Remaining: scheduler loop and automation UI.

  Examples: run dependency checks every morning, review new CI failures, watch for file or branch change, periodically run repository health check, notify when long-running task finishes. Requirements: reuse same permission system and completion contracts; every automation run creates inspectable history; automation failures enter Attention Inbox; no hidden background agents.

---

## Cross-cutting infrastructure

- [ ] **Event model** — normalize significant runtime activity into stable events. Partially done: `makeId` (timestamp + monotonic counter + `crypto.randomUUID`) and `ProtocolEnvelope` with stable ids on daemon boundary. Remaining: full event catalog (`message.sent`, `turn.started`, `turn.completed`, `tool.started`, `tool.completed`, `approval.requested`, `approval.resolved`, `process.started`, `process.exited`, `checkpoint.created`, `plan.proposed`, `plan.approved`, `task.blocked`, `task.completed`, `attention.created`, `attention.resolved`) and replay/projection.

- [ ] **Stable ownership** — every long-lived resource should identify its owner (`projectId`, `taskId`, `sessionId`, `agentId`, `turnId`, `toolRunId`, `processId`, `worktreeId`). Partially done via `ownerSession`, `sessionId`, `agentId` fields on tasks/processes/plans. Remaining: enforce at every subsystem boundary and avoid deriving ownership from whichever UI panel happens to be open.

- [ ] **Observability** — developer-facing runtime diagnostics surface covering Pi runtime state, model availability, project resources, language servers, active processes, worktrees, permission engine, background tasks, event queue health; plus a single diagnostic export without prompts/tool output/secrets/source. Not yet started.

---

## Recommended shipping order

Next

- Agent permission system
- Automatic risk review
- LSP diagnostics feedback loop
- Agent-aware terminal/process manager
- Browser preview

After that

- Structured plans
- Attention inbox
- Completion contracts
- Task-owned worktrees
- Structured subagent graph
- Hook system
- Model roles

Later

- Babylon daemon
- Background execution policies
- Remote/mobile control
- Scheduled and conditional tasks

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
