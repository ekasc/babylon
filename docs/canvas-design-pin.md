# Canvas — pinned design brief

Parked for a later brainstorming pass (external). Captures what's already decided
so the thinking doesn't have to be redone.

## The idea

An Excalidraw-like canvas inside Babylon where the human and the agent share one
artifact:

- send the screen (or a region) to the agent in one click
- the agent creates diagrams — plans, architecture, UI props — on the canvas
- the human sketches a UI roughly; the agent reads it and implements it
- round trip: agent draws a wireframe → human edits it → agent implements the edit

## Locked decisions

1. **The canvas is code, not pixels.** Both parties read/write the same textual
   medium. This is the load-bearing choice.
2. **The scene is a file on disk**, not a bespoke IPC surface. The agent uses the
   `read`/`write`/`edit` tools it already has; the renderer watches and reloads.
   The canvas API for the agent shrinks to ~2 tools: `render` (self-verification)
   and `read_ink` (freehand only).
3. **Two node classes in one scene**, not two separate documents:
   typed nodes (code, agent-native) + ink paths (raster, agent-opaque). Real work
   mixes them — components laid out *and* an arrow saying "wrong spacing".
4. **Vision runs once, at compile — never per turn.** Freehand → "compile to spec"
   → typed nodes. Per-turn vision makes the flaky, expensive path the default.
5. **V1 is the Mermaid → editable-canvas flow**, not the UI DSL. Mermaid is already
   a dependency, already rendered (`src/components/MermaidBlock.tsx`, wired in
   `Markdown.tsx`), already code, and models are fluent in it. It proves the
   round-trip for a fraction of the cost.
6. **Freeform → code is a compiler with a perception front-end**, not a prompt:
   - geometry (loops, arrows, containment, alignment) → deterministic code
   - text + per-region role classification → VLM, cropped, schema-constrained
   - assembly + DSL emission → deterministic code
   - **the model never writes the DSL**; it classifies, the compiler emits.

## Open questions

- Does the agent read ink automatically, or only when the user sends/compiles?
  (Recommendation was: explicit only.)
- Does the human edit the DSL as text, or only the canvas? No code editor in the
  tree (Shiki is display-only), so text editing is a new dependency.
- One source of truth for layout: auto-layout only, or explicit `at (x,y)`
  overrides the agent must never author?
- Is the canvas per-project or one global scratchpad?

## Known traps

- **Freehand is the easy path.** If drawing is faster than the palette, users always
  draw and every turn pays vision. The structured path must win on convenience,
  not just fidelity, or this becomes a whiteboard with an expensive attachment.
- **Round-trip is one-way.** Code → ink is impossible. Archive the ink after
  compiling; never promise freehand comes back.
- **Ambiguity is irreducible.** The pipeline must be allowed to say "I don't know"
  with a confidence score and ask, instead of inventing specifics.
- **Misclassification compounds.** A wrong role poisons everything nested under it.
- **A sketch carries structure, containment, labels, intent** — not tokens,
  spacing, colour, or states. That's a feature: it forces every sketch onto real
  components instead of a parallel UI.
- **Screenshot privacy.** One-click full-screen capture to a model is an
  exfiltration footgun; must route through the permission engine and be scoped.
  A bare screenshot carries little intent — the annotation carries it.

## Artifacts worth writing next

1. The `.canvas` DSL grammar + `Scene`/`Node` types.
2. The `Region` → `Node` compiler contract: role enum, containment rules,
   change-list schema. This is the part that must be right, and it is all
   deterministic code testable without a model.
3. Tracer bullet: **agent writes a scene → human edits on the canvas → agent
   re-reads the diff and implements it.** Before any vision path is built.

## Make-or-break test

Is the visual round-trip actually more reliable than typing the change? Two
misreads and the user reverts to prose and the feature is dead. Measure the first
slice against prose on a real change.

## Verified facts

- `@excalidraw/excalidraw` 0.18.1 — MIT, supports React 19 (we're on 19.1).
  `customData` per element is supported; custom **element types** are not
  (excalidraw/excalidraw#4957).
- `tldraw` 5.4.2 — first-class custom shapes (`ShapeUtil`), but non-MIT license
  and needs React ≥19.2.1.
- `describeImages` (electron/pi-host.ts) asks for free-text prose, and
  `completeSimple(model, context, options?)` exposes no `responseFormat`/
  `jsonSchema` in the SDK typings — structured classification needs its own path.

## Research worth revisiting

- DAPLab, *9 Critical Failure Patterns of Coding Agents* — the "misalignment gap"
  framing ("users describe what they see, agents operate on the code"), and
  silent error suppression as the dominant failure.
- tianpan.co, *The Context Window as IDE* — repo maps, JIT context, the 5–10 tool
  ceiling, project memory under ~200 lines.
- arXiv 2605.24660, *How Many Tools Should an LLM Agent See?* — shortlist depth as
  the object of evaluation, registries of 20–3,251 tools.
