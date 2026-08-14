# DESIGN.md

Documentation of the committed visual system in Babylon (identity-preserving; captured
from `src/styles.css`, components, and product conventions).

## Theme

Light and dark, driven by CSS custom properties on `:root` and `html.dark`. Both themes
use the same token names; only values change.

- Light: near-white neutral background (`#f7f7f6`), white raised surfaces, ink text (`#171716`).
- Dark: warm charcoal (`#191919` bg, `#242424` raised), near-white text, slightly muted dims.

Chrome (sidebar, nav, composer) uses translucent surfaces so content stays legible while
scrolling; `prefers-reduced-transparency` removes the translucency.

## Color

Restrained strategy: tinted neutrals plus a single blue accent used for primary actions,
current selection, and state indicators only.

- `--accent`: `#2563c7` (light) / `#72a7ff` (dark), with an `--accent-soft` tint for selected rows.
- Semantic: `--ok` green, `--err` red, `--warn` amber; diff colors for added/removed lines.
- Text ramp: `--fg` ink, `--dim` secondary. Borders: `--line`, `--line-strong`.

## Typography

System stack only: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue",
"Segoe UI", sans-serif`. No display pairing, no fluid clamps; 16px base, 1.5 line height.
One family carries headings, labels, body, and data (product register: a well-tuned sans).
Monospace reserved for code and diffs via the Markdown renderer.

## Components

- Product vocabulary: buttons, text inputs, selects, toggles, and dialog/sheet surfaces all
  share one shape language (small radii, 1px borders, `context-button` and `thread-action`
  primitives).
- State coverage: every interactive component has default, hover, focus, active, disabled;
  error and empty states exist for loading surfaces (skeletons preferred over spinners).
- Empty states teach the interface (e.g. the conversation-empty prompt).

## Motion

- Springs, not CSS transitions, for anything touchable: a dependency-free spring engine
  (`src/lib/spring.ts`) implementing Apple fluid-interface principles (critical damping by
  default, velocity handoff for gestures). Drives transform/opacity via rAF, never layout.
- 150-250ms for state transitions; motion conveys state (arrival, change, selection),
  never decoration.
- `prefers-reduced-motion: reduce` settles all springs and disables non-essential
  animation at the engine level.

## Layout

- Fixed app shell: sidebar navigation, center conversation column (content-width column
  inside a full-bleed scroll area), context drawers (Activity/History/worktree) that
  overlay or split on the right.
- Dense information density for data surfaces (History, Activity, tool cards); the
  conversation keeps comfortable line lengths.
- Semantic z-index scale via Tailwind layering; popovers/dialogs escape clipped containers.

## Accessibility

AA targets; keyboard-first; visible focus rings via `--focus`; destructive actions
confirmed; reduced-motion/transparency/contrast preferences all wired.
