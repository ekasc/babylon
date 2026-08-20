# DESIGN.md

Documentation of the committed visual system in Babylon (identity-preserving; captured
from `src/styles.css`, components, and product conventions).

## Theme

Light and dark, driven by CSS custom properties on `:root` and `html.dark`. Both themes
use the same token names; only values change.

- Light: cool near-white (`oklch(0.976 0.005 260)`), near-white raised surfaces, ink text (`oklch(0.204 0.01 260)`).
- Dark: **near-black** canvas with **neutral dark-grey** surfaces (zero-chroma greys, `oklch(0.072 0 0)` bg, `oklch(0.112 0 0)` raised), near-white text, slightly muted dims. No blue tint — the sidebar sits even deeper (`oklch(0.05 0 0)`, `#050505` in the t3code-style override) so content and the multi-hue project accents pop against it.

Chrome (sidebar, nav, composer) uses translucent surfaces so content stays legible while
scrolling; `prefers-reduced-transparency` removes the translucency.

## Color

Near-black canvas, **neutral dark-grey** surfaces, **colorful accents**. The chrome is pure
grey (zero-chroma) so the surface reads as near-black; all color is carried by accents, not the
chrome. A multi-hue palette (`src/lib/colors.ts`) assigns each project a stable, deterministic
accent (violet / blue / cyan / emerald / amber / orange / rose / fuchsia) keyed by its cwd, so
the same project always reads with the same color.

- `--accent`: `#2563c7` (light) / `#7aa2ff` (dark) — primary actions, selection, focus.
- **Per-project accent** (`--pc`): drives the active session's left bar, the project dot in each
  session row, and the unread indicator, so projects are visually distinguishable at a glance.
- Semantic: `--ok` green (`#4ade80`), `--err` red (`#f87171`), `--warn` amber (`#fbbf24`) for
  vibrant status pills (running / blocked / settled) and diff colors for added/removed lines.
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
