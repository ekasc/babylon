# Product

## Register

product

## Users

Professional developers using the pi coding agent. They live in the terminal and in long
agent sessions: multi-hour turns, many tools, several parallel threads and subagents, and
sessions that span days. Their context when using Babylon is a focused work session at a
desktop machine, typically with one repo open and a tight loop of prompt, review, iterate.

## Product Purpose

Babylon is a secure desktop workspace for the pi coding agent. It gives the agent models the
tools to maximize efficiency: fast project and session navigation, a streaming conversation
with full tool visibility, persistent workflows/threads/subagents, truthful session History,
exact rollback, and worktrees, all backed by the user's existing pi configuration.

Success looks like the tool disappearing: the agent's work becomes the fastest, clearest thing
on screen, and the interface never costs the user a moment of waiting or a false read of state.

## Brand Personality

Focused, fast, precise. An instrument, not a toy.

Voice is quiet and exact. The interface earns trust by never hesitating, never misrepresenting
state, and never decorating over the agent's actual work.

## Anti-references

- Electron apps that feel like web pages: sluggish input, chatty decorative motion, card-everything layouts.
- Tools that fake progress or hide state behind animation.
- Any interface that makes the user wait longer than the work requires.

## Design Principles

- Zero hesitation. A fast-feeling instrument beats a pretty one. Every interaction lands in
  single-digit to low-hundreds of milliseconds, and nothing blocks the main thread.
- Truthful state. What the UI shows always matches what the agent actually did. No invented
  status, no stale activity, no hidden ownership.
- The agent's work is the hero. Chat, tool output, diffs, and session ancestry get the
  attention; chrome stays quiet.
- Motion conveys state, not decoration. Springs and transitions exist to communicate what
  changed and where it came from, and to never interrupt flow.
- Accessibility is non-negotiable. Reduced motion, reduced transparency, increased contrast,
  and keyboard-first operation are shipped with every feature.

## Accessibility & Inclusion

WCAG AA targets. Full keyboard operation, `prefers-reduced-motion` honored at the engine
level (springs settle instantly), `prefers-reduced-transparency` and
`prefers-contrast-more` supported in the theme, and destructive actions always confirmed.
