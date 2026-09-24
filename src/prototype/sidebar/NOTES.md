# Prototype — Sidebar UI

**Question:** what should the session sidebar look like? The current one is a
project tree that repaints on every streamed token. Three structurally
different variants, switchable via `?variant=`.

**Run:** `pnpm prototype:sidebar`, then open
`http://127.0.0.1:5173/prototype-sidebar.html` (dev-only; not in the app build).

## Variants

- **A — Activity rail (`?variant=A`).** Two-pane: a 56px icon rail switches
  project, the adjacent panel lists that project's sessions flat. Primary
  affordance = pick a project. Familiar (VS Code), scales to many projects,
  hides cross-project attention.
- **B — Inbox, state-first (`?variant=B`).** Single column sectioned by
  *what needs you*: Needs you / Running / Recent. Project is a muted inline
  label, not a container. Primary affordance = triage. Best when the job is
  "clear the queue", worst when you think in projects.
- **C — Timeline, time-first (`?variant=C`).** Recency gutter (Now / Today /
  Earlier) with a vertical rail and status dots. Primary affordance = scan by
  when, not what/where. Strong for "what was I doing", weak for project work.

## Verdict

_(not yet chosen — flip through and note which variant, or which mix, wins;
validation note goes here before this prototype is deleted)_
