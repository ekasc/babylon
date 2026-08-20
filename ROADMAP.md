Babylon Roadmap

Babylon is a secure desktop workspace for the Pi coding agent. The next phase should focus on execution infrastructure rather than adding more chat surface area.

The goal is to make Babylon capable of safely running long-lived, parallel software-engineering work with strong visibility, isolation, recovery, and user control.

Guiding Principles

Pi remains the agent engine. Babylon should orchestrate, observe, constrain, and extend it rather than reimplementing the core agent loop.

Agent state must be truthful. Never infer progress from animation or text when a concrete runtime state exists.

Every long-running task should be resumable, inspectable, and interruptible.

Parallel work should be isolated by default.

The user should only be interrupted when their input is genuinely required.

Security should be expressed as explicit execution policy, not vague warnings.

New infrastructure must preserve Babylon's existing session history, rollback, worktree, extension, skill, and project-trust behavior.

Keep the main interface dense, fast, keyboard-first, and free of unnecessary chrome.

Phase 1: Execution Control

1. Agent Permission System

Add a Babylon-owned permission layer around agent actions.

Execution modes

Supervised: ask before commands, writes, external access, and other consequential actions.

Auto: routine actions run automatically, risky or uncertain actions require approval.

Full Access: run without interactive approval prompts.

Approval actions

Each approval request should support:

Allow once

Allow for this session

Always allow matching actions

Deny

Policy categories

At minimum, policies should distinguish:

File reads

File writes inside the workspace

File writes outside the workspace

Shell commands

Destructive shell commands

Network access

Git commit

Git push

Package installation

Process spawning

Privileged commands

Requirements

Policies are evaluated before execution.

Persistent rules are stored outside Pi session files.

Session-only rules disappear with the session.

Approval state is visible in the transcript and Activity surfaces.

Rules are editable in Settings.

Full Access must be visibly distinct from safer modes.

2. Automatic Risk Review

Add a secondary review step for actions that are not clearly allowed or denied by static policy.

Flow:

Agent action
    ↓
Static policy
    ↓
Clearly allowed? ── yes → execute
    ↓ no
Risk review
    ↓
Low risk → execute
High/uncertain risk → ask user

The reviewer should consider:

command intent

affected paths

destructive flags

external network access

privilege escalation

repository state

current project boundary

The reviewer must never override an explicit deny rule.

Phase 2: Coding Intelligence

3. LSP Integration

Add a language intelligence service that Babylon can expose to Pi.

Initial capabilities

Diagnostics

Go to definition

Find references

Hover information

Rename

Code actions

Agent feedback loop

After a file edit:

Agent edits file
    ↓
Language server runs diagnostics
    ↓
New errors/warnings are collected
    ↓
Relevant diagnostics are returned to the active agent
    ↓
Agent can fix them without waiting for the user

Requirements

Diagnostics should be diff-aware where possible.

Avoid flooding the agent with unchanged diagnostics.

Language servers should be project-scoped.

Server crashes must not destabilize the main agent session.

Surface current diagnostics in the workspace UI.

4. Structured Plans

Plans should become first-class Babylon state rather than plain assistant Markdown.

A plan contains:

ordered steps

step status

optional dependencies

affected areas/files when known

approval state

execution progress

Plan actions

Edit

Approve

Reject

Reorder steps

Add/remove steps

Execute one step

Execute all

Pause after current step

States

Proposed
Approved
Running
Paused
Blocked
Completed
Cancelled

The agent should be able to propose a plan and stop before implementation when plan approval is required.

Phase 3: Runtime Workspace

5. Agent-Aware Terminal

Add a first-class terminal and process manager.

Babylon should track processes rather than treating every terminal as an opaque shell.

Process metadata

Each tracked process should include:

command

cwd

owning session/agent

PID

start time

exit status

detected ports

current state

Example

TERMINALS

● dev server       pnpm dev       :5173
● tests            vitest
○ shell            zsh

Created by: Main Agent

Requirements

Interactive PTY support

Multiple terminals per task

Kill/restart controls

Agent-created processes appear automatically

Exited processes remain visible in history

Output can be referenced by the agent

Terminal ownership is explicit

6. Browser Preview

Add an integrated preview surface for local web applications.

Automatic behavior

When Babylon detects a local HTTP server:

pnpm dev
    ↓
localhost:5173 detected
    ↓
Preview available

Preview capabilities

Navigate

Reload

Open current URL externally

Inspect console output

Capture screenshot

Select elements

Report page errors

Basic agent-driven interaction

Agent tools

Expose Babylon-owned preview capabilities back to Pi, such as:

preview_open
preview_navigate
preview_click
preview_type
preview_screenshot
preview_console
preview_inspect

The agent should be able to validate UI changes without requiring the user to manually describe the result.

Phase 4: Parallel Work

7. Task-Owned Worktrees

Upgrade worktrees from a standalone feature into a task execution primitive.

A task may own:

Task
├── Pi session
├── Git branch
├── Git worktree
├── terminals
├── preview
├── diff
└── checkpoints

Behavior

Creating a parallel implementation task can automatically create a worktree.

Worktree and branch names are generated deterministically but editable.

Removing a task must not silently destroy uncommitted changes.

Task state survives Babylon restart.

The user can promote or merge completed work back into the primary workspace.

8. Structured Subagent Graph

Expand the current agent system into a clearer hierarchy of work.

Example:

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

Requirements

Parent/child relationships are explicit.

Each agent has a goal, state, model, owner, and result.

Subagent output defaults to summaries rather than flooding the parent transcript.

Full transcripts remain inspectable.

Agents may run in isolated worktrees.

Bounded and persistent agents remain distinct concepts.

9. Model Roles

Generalize Babylon's existing use of cheaper models for background work into explicit roles.

Suggested roles:

Primary
Planner
Scout
Reviewer
Recap
Title

Each role can configure:

provider/model

reasoning level

token budget

fallback model

Requirements

Roles are optional.

The primary session model remains independent.

Background roles must not silently consume expensive models.

Show which model performed generated summaries, reviews, or plans.

Phase 5: Attention and Completion

10. Attention Inbox

Create one global place for everything that genuinely needs the user.

Attention types

Permission request

Agent question

Failed task

Blocked task

Merge conflict

Missing credential

Environment failure

Review requested

Example

NEEDS YOU

! Auth refactor
  Permission required: git push

! Search redesign
  Agent needs a product decision

! CI fix
  Tests failed after 3 repair attempts

Requirements

Works across projects and sessions.

Items disappear when resolved.

User can jump directly to the originating context.

Background agents should not require the user to keep their chat open.

11. Completion Contracts

Allow users or projects to define what must be true before Babylon considers a task complete.

Example:

Definition of Done

✓ Typecheck
✓ Unit tests
✓ Lint
✓ No new diagnostics
○ Browser smoke test
✓ Diff reviewed

Possible checks

command exits successfully

tests pass

typecheck passes

lint passes

no new LSP errors

no unresolved TODO markers introduced

working tree state matches policy

browser smoke test passes

review agent approves

Behavior

An agent may say it believes the task is finished, but Babylon should distinguish:

Agent finished

from:

Completion contract passed

The second one is the trustworthy state.

12. Hook System

Add a small, stable Babylon hook lifecycle.

Start with:

pre_tool_use
post_tool_use
before_stop
attention_required

Examples

pre_tool_use

block a command

rewrite safe arguments

require approval

attach metadata

post_tool_use

run diagnostics after edits

update process state

update Git state

before_stop

verify completion contract

require tests before final completion

request one more repair pass

attention_required

create an Attention Inbox item

notify a remote client later

Hooks must have strict timeouts and must not be allowed to deadlock the agent runtime.

Phase 6: Control Plane

13. Extract the Runtime into a Babylon Daemon

Move long-lived orchestration out of the Electron application process.

Target architecture:

                 Babylon Daemon
                       │
        ┌──────────────┼──────────────┐
        │              │              │
       Pi          Task State     Processes
        │              │              │
     Sessions       Worktrees       Terminals
        │              │              │
        └──────────────┼──────────────┘
                       │
              Typed local protocol
                       │
             ┌─────────┴─────────┐
          Desktop             Future clients

Daemon responsibilities

Pi host lifecycle

session state

task state

approvals

terminals/processes

worktrees

attention state

background execution

persistence

Desktop responsibilities

rendering

keyboard interaction

dialogs

local notifications

previews

user input

Requirements

Closing the GUI must not kill background agents unless configured to do so.

Reopening Babylon reconnects to existing tasks.

Protocol events carry stable task/session/tool IDs.

Runtime state remains authoritative outside React.

Do not perform this extraction until the execution/task APIs above have stabilized enough to justify the boundary.

14. Background Execution Policies

Once the daemon exists, support explicit policies for background work.

Examples:

Background execution

○ Never
● While plugged in
○ Always

Additional controls:

Pause on battery

Pause on sleep

Resume after wake

Maximum concurrent agents

Maximum background model cost

Per-project background permission

Phase 7: Remote Control

15. Remote and Mobile Control

Allow the user to inspect and control active Babylon tasks from another trusted device.

Initial remote scope should be intentionally small:

View active tasks

View current agent state

Receive attention notifications

Approve/deny actions

Answer agent questions

Stop/pause/resume tasks

View concise diffs and completion state

Do not attempt to recreate the entire desktop workspace on mobile.

Pairing

Use explicit device pairing with revocable grants.

Each device should have:

device identity

authorization scope

creation time

last-seen time

revoke control

Phase 8: Automation

16. Scheduled and Conditional Tasks

After background execution is reliable, allow Babylon tasks to run without an open foreground session.

Examples:

Run dependency checks every morning

Review new CI failures

Watch for a file or branch change

Periodically run a repository health check

Notify when a long-running task finishes

Requirements

Reuse the same permission system.

Reuse completion contracts.

Every automation run creates inspectable history.

Automation failures enter the Attention Inbox.

No hidden background agents.

Cross-Cutting Infrastructure

Event Model

As Babylon gains more asynchronous systems, normalize significant runtime activity into stable events.

Examples:

message.sent
turn.started
turn.completed
tool.started
tool.completed
approval.requested
approval.resolved
process.started
process.exited
checkpoint.created
plan.proposed
plan.approved
task.blocked
task.completed
attention.created
attention.resolved

This does not require immediately converting all existing state to full event sourcing. Start by defining stable IDs and event contracts at subsystem boundaries so the future daemon can replay and project reliable state.

Stable Ownership

Every long-lived resource should identify its owner.

projectId
taskId
sessionId
agentId
turnId
toolRunId
processId
worktreeId

Avoid deriving ownership from whichever UI panel happens to be open.

Observability

Add a developer-facing runtime diagnostics surface covering:

Pi runtime state

model availability

project resources

language servers

active processes

worktrees

permission engine

background tasks

event queue health

Provide a single diagnostic export that contains system state without silently including user prompts, tool output, secrets, or source code.

Recommended Shipping Order

Next

Agent permission system

Automatic risk review

LSP diagnostics feedback loop

Agent-aware terminal/process manager

Browser preview

After that

Structured plans

Attention Inbox

Completion contracts

Task-owned worktrees

Structured subagent graph

Hook system

Model roles

Later

Babylon daemon

Background execution policies

Remote/mobile control

Scheduled and conditional tasks

Explicit Non-Goals for Now

Do not prioritize these ahead of the roadmap above:

More decorative chat UI

Replacing Pi's agent loop

Replacing Pi's session format

A built-in source-code editor competing with existing editors

Cloud synchronization before the local control plane is robust

Generic plugin marketplace infrastructure

Multi-user collaboration

Enterprise RBAC

Container or Kubernetes orchestration

Arbitrary provider abstraction before Babylon's Pi experience is complete

North Star

Babylon should become the place where the user controls software-engineering agents, not another place where they manually manipulate code.

The desktop experience should eventually make it possible to:

Describe a task.

Approve or edit the plan when necessary.

Let isolated agents execute in parallel.

Only be interrupted for real decisions or consequential actions.

Review precise diffs, diagnostics, runtime state, and completion checks.

Roll back, branch, merge, or continue from any meaningful point.

Leave the app and trust that Babylon still knows exactly what every agent is doing.
