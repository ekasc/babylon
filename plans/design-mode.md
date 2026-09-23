# Design mode — phased design flow with automated visual review

Objective: bring tastecode's *design-mode idea* (not its code) to Babylon as a
pi-native skill flow: elicitation → brief artifact → brand direction + approval →
build → automated visual review loop, all inside Babylon's existing runtime.

## Status (2026-09-22)

Shipped M0–M7 in Babylon's runtime, end-to-end exercisable through `/design`:

- M0: spike notes in `plans/design-mode-m0-spike.md` (code-verified; live
  eyeball still wants a human run).
- M1: `SimController.captureReview()` + `browser_capture_review` tool
  (multi-viewport screenshots, console/page errors, settle constants).
- M2–M7: hardbaked `electron/design-mode/` extension (`/design`), same
  pattern as goal-mode: stage derives from artifacts
  (`.babylon/design/<slug>-brief.md`, `-brand.md`, `-log.md` newest-first),
  per-session state, per-turn playbook injection.
- Entry: `/design start <subject>` (palette + composer, like `/goal`).
  Re-running resumes from current artifacts.

One deviation: M3's gate runs through `ask_question` (Approve / Revise with
note / Deny) plus explicit `/design approve-brief` / `approve-brand`
commands — not new permission-engine plumbing. Reason: the engine resolves
boolean allow/deny on tool calls, which cannot carry a revise note; a text
verdict gate would have meant new Risk/Action plumbing for what is really
a decision dialog. Build stays under the existing permission engine.

Audit (subagent, 2026-09-22): verdict fix-first. Fixed: invalid readySelector
failing loud instead of screenshotting unsettled pages; reviews capture into
a dedicated tab (active tab restored, review tab closed) instead of hijacking
it; trailing quiet period after the selector signal; stale approvals lapsed
when artifacts are deleted; empty-slug fallback; stored artifact paths pinned
to slug-derived values; single REVIEW_MAX_VIEWPORTS in src/lib/simulator.ts;
dead `rounds` field removed. Deferred: console-level mapping needs one live
Electron confirmation (M2); abort-signal threading; buildEmulation fail-open
(latent, all callers validate).

Corrections (2026-09-22): all three closed. The console listener now reads the
event details object (`level === "error"`) instead of the deprecated
positional args — which, per electron.d.ts, would have compared a
MessageDetails object against 3 and captured nothing, ever. buildEmulation
throws on unknown presets (findPreset keeps its UI fallback; sanitizeViewport
already validates). Cancellation threads the tool's abort signal through
settle waits and viewport turns, worst case ~10s past abort instead of ~84s.

Non-goals:
- No line-for-line port of tastecode's `design-agent` package. The phases are
  re-expressed as pi skill prompts plus small Babylon chassis; no parsers cross
  over. (Tastecode is Apache-2.0, so vending would be legal with attribution,
  but the port is cleaner and a courtesy heads-up to Leon is owed before any
  code moves either way.)
- No new in-app browser work. The sim guest + CDP + agent tools already exist.
- No cross-engine verification. Chromium-only review now; real Safari/Firefox
  spot-checks via agent-browser are explicitly later.

## Starting position (verified, not assumed)

- `electron/sim-tools.ts`: agent tools driving tabbed Chromium guests (open,
  snapshot, JS eval escape hatch). CDP via `webContents.debugger`
  (`sim-controller.ts`): `capturePage`, condensed T3-style a11y trees.
- `SimulatorPanel` + device presets (`src/lib/simulator.ts`): DPR-correct,
  UA spoofing, touch emulation. Engine stays Chromium throughout.
- `src/preview-model.ts`: dev-server detection from process-manager observed
  processes (ports, framework inference, liveness). Process manager itself is
  done (Milestone 1): real spawn/PTY/kill, detected output ports.
- Skills/composer/permissions: pi remains the engine; approvals gate tool
  calls; `CanvasPanel` is a diagram surface, NOT a web surface — review
  captures go through the sim guest, never the canvas.
- pi RPC supports everything the loop needs (verified against pi 0.86.1:
  model listing, state, prompt, abort).

## Rules

- Babylon Definition of Done per milestone: real runtime, end-to-end,
  user-exercisable through Babylon, no fakes. A skill file is not Done. A
  capture script is not Done. A judge prompt is not Done.
- One milestone at a time; `tsc --noEmit` + full suite green before next.
- Only files that trace to the milestone. No drive-by refactors.
- Node scripts (`.mjs` under `scripts/`), never shell scripts.
- Bounded automation everywhere: retries and round budgets are constants,
  escalation to the user is a designed outcome, not a failure mode.

## M0 — Spike: one hand-driven review pass (no chassis)

Goal: answer the unknowns before building anything.
- Serve a real target (aoi Us screen: Expo web export or dev server).
- Hand-drive via existing sim-tools: open tab, set mobile + desktop
  viewports, wait/settle, screenshot, console + page errors, ax snapshot.
- Hand pi the captures + a short brief; judge actionable or not; run one
  revise round by hand.
- Record: capture quality, settle timing/strategy, verdict actionability,
  what the tool surface is missing (composite capture tool? settle policy?
  multi-viewport helper?).

Done when: the spike notes name the exact chassis M1 must build, or prove
the loop unworkable and stop the project here.

## M1 — Review capture bundle

Goal: one call that turns a URL + brief viewports into a review bundle.
- New capability on the sim surface (tool or main-process composite):
  `{ screenshots: [{viewport, png}], consoleErrors, pageErrors, axSnapshot,
  textSnapshot, url }`, with an explicit settle policy (selector + quiet
  period constants, not magic).
- Viewports driven by the brief (mobile + desktop minimum), DPR-correct.

Done when: user runs it against a local fixture page from the command
palette (or skill), and the returned bundle matches what the spike proved
sufficient — eyeballed, not asserted.

## M2 — Brief elicitation skill + brief artifact

Goal: design work starts from an interview, never a bare prompt.
- `design` skill, stage 1: pi asks the elicitation questions, then writes a
  brief artifact (markdown, in-workspace, human-readable: subject, scope,
  goals, audience, required content, constraints).
- Stage advances only on explicit user confirmation of the brief.

Done when: user runs the skill in Babylon on a real screen, answers,
  confirms, and can open the brief file afterwards. Resumable: re-running
  continues from the existing brief.

## M3 — Brand direction + approval gate

Goal: visual system decided and signed off before any component exists.
- Skill stage 2: pi proposes direction (tokens, type, rhythm, reference
  images/palette) as a brand artifact.
- The proposal arrives as a **real approval request** through the permission
  engine (approve / deny / revise-with-note). Build stage is unreachable
  until approval.

Done when: user approves a real brand direction in-app and the artifact
  persists; denying returns to revision, not to limbo.

## M4 — Build execution under policy

Goal: pi implements in the workspace with Babylon watching.
- Skill stage 3: implementation turns under the existing permission engine
  (file writes governed, attention inbox fed by real failures).
- Interruptible and resumable per the long-running-task principles; work
  lands on a branch/worktree, never straight onto the user's checkout
  unless asked.

Done when: a build stage completes on a real project with the user able to
  interrupt mid-turn and resume without loss.

## M5 — Judge turn + bounded revise loop

Goal: the automated visual check.
- Judge: pi (vision) compares M1 captures against brief + brand, returns
  pass/fail with a concrete punchlist. Prompt lives with the skill;
  verdicts are thread-visible, never silent.
- Revise: fail feeds one targeted build turn + re-capture. Budget: 3
  rounds, then escalate to the user with captures and punchlist attached.
  Escalation is a designed outcome.

Done when: an intentionally seeded defect (wrong spacing, missing section)
  is caught by the judge and fixed within budget on a real screen,
  user watching but not driving.

## M6 — Provenance

Goal: every design turn is reviewable after the fact.
- Per-iteration captures + verdicts + punchlists attached to the thread
  (or a design artifact folder), newest-first.
- "Why this spacing" has a picture answer.

Done when: user opens a finished design thread a day later and can
  reconstruct every visual decision from attached captures.

## M7 — Entry points + docs

Goal: discoverable, documented, boring to operate.
- Command palette / composer entry for the skill; brief/brand templates
  documented; failure modes (no server detected, guest crash, judge
  inconclusive) each have a real, observable UI state.
- Docs updated alongside (not after).

Done when: a user who never read this plan can start, steer, and finish a
  design turn, including one escalation path, without asking for help.

## Open questions (answer in M0/M1, not now)

- Settle policy constants: which selector signal + quiet period per target
  class (static export vs dev server vs Expo web)?
- Retry/round budgets: 3 revise rounds default — tunable per skill or fixed?
- Artifact home: workspace dir (e.g. `.babylon/design/`) vs session
  attachments. Must survive thread disposal; must not pollute the repo.
- Expo-class targets: exact serve command per framework for the review
  stage (aoi is the reference case).
- Real-engine checks (agent-browser, Safari/Firefox): deferred, but note
  where the viewport abstraction would accept a second capture backend.

## Explicitly deferred

- Vendoring tastecode parsers/state machines (see Non-goals).
- In-app preview UX beyond what review needs (human-facing preview remains
  roadmap-future; the loop does not wait for it).
- Cross-provider design (Babylon is pi-native by principle; no adapter
  layer will be introduced for this feature).
