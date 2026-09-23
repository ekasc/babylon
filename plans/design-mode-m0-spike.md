# M0 spike notes — one hand-driven review pass (design-mode plan)

Date: 2026-09-22. Script: `scripts/design-mode-m0-spike.mjs` (bounded, single
pass, disposable fixture; not shipped chassis). Bundles:
`/tmp/babylon-design-m0/{base,fix}-{chrome-laptop,iphone}.png`,
`{base,fix}-bundle.json`.

## What was run

- Real target: local `node:http` fixture (aoi-style task screen: hero +
  footer; brief additionally requires a pricing section and 48px hero
  padding). Seeded defects in base: pricing section missing, hero padding
  8px, one `console.error`, one uncaught page error on load.
- Hand-drive mirroring the existing sim-tools surface: open URL, emulate
  desktop (`chrome-laptop` 1440x900 DPR2) + mobile (`iphone` 393x852 DPR3),
  settle, screenshot, console + page errors, text snapshot, ax snapshot.
  Playwright Chromium stands in for the sim guest (engine is Chromium in
  both; CDP ax path in `SimController`/`sim-a11y.ts` is unit-tested
  separately — Playwright's own `accessibility.snapshot` returned ~nothing
  here and was not used as evidence for/against the CDP path).
- Judge: brief + captures reviewed by hand. Revise: `--fix` variant
  (pricing added, hero 48px), re-captured once.

## Results

| viewport | selector signal | settle (signal+800ms quiet) | console | page errors | text |
|---|---|---|---|---|---|
| chrome-laptop base | 368ms | 1168ms | 1 | 1 | 44 chars, no Pricing |
| iphone base | 337ms | 1137ms | 1 | 1 | 44 chars, no Pricing |
| chrome-laptop fix | ~same | 1183ms | 1 | 1 | 61 chars, Pricing present |
| iphone fix | ~same | 1143ms | 1 | 1 | 61 chars, Pricing present |

- Verdict round 1: FAIL with concrete punchlist (add pricing section;
  hero padding 8px -> 48px; console + page error noted). All three defects
  were visible in the bundle without opening the page.
- Verdict round 2 (after one hand revise): PASS on visual punchlist
  (pricing present in text snapshot, screenshots grew accordingly).
  Console/page errors persisted — seeded infra noise, correctly separable
  from the visual verdict.
- Verdict actionability: YES. Captures + 3-line brief were sufficient; no
  extra tooling was needed to write the punchlist or verify the fix.

## Capture quality (reusable vs missing)

Reusable as-is: viewport screenshots (DPR via emulation), rendered-text
snapshot, condensed CDP ax tree (`sim-a11y.ts`), per-tab serial chains,
debugger channel with refcounting (`SimController.withDebugger`).

Missing (this is the M1 build list):
1. **Console + page-error capture on the sim surface.** Nothing in
   `SimController`, `sim-tools.ts`, or `sim-ipc.ts` collects guest console
   errors or page errors (`main.ts` only watches the app window). Spike
   caught both seeded errors trivially via `page.on("console"/"pageerror")`;
   the Electron equivalent is CDP `Runtime.consoleAPICalled` /
   `Runtime.exceptionThrown` (+ `Log.entryAdded`) or `webContents`
   `console-message` / uncaught hooks per guest, collected per capture
   window.
2. **Settle policy.** Tools today await `loadURL` only. The spike's
   `domcontentloaded` + selector signal (`#app[data-ready=true]`,
   ~340-370ms) + fixed 800ms quiet period settled in ~1.15s total and never
   flaked over 4 passes. M1 must enshrine this as constants (selector +
   quiet period + nav timeout), not per-call magic.
3. **Composite review-capture bundle.** No single call returns
   `{ screenshots[{viewport, png}], consoleErrors, pageErrors, axSnapshot,
   textSnapshot, url }`. M1 builds exactly this shape (plan M1), reusing
   `screenshot` / `snapshot` / `axTree` plus (1) and (2) above.
4. **Multi-viewport helper.** Briefs need mobile + desktop minimum; today
   that is N emulate + N screenshot round trips. The bundle call should
   take the brief's viewports and do both in one pass.
5. **Entry point.** M1 Done requires invoking the bundle from the command
   palette (or skill) against a local fixture page — eyeballed match with
   this spike's output, not new assertions.

## Verdict: loop workable, proceed to M1

No stop condition met. Per-target-class settle constants (static export vs
dev server vs Expo web), revise-round budgets, and artifact home
(`.babylon/design/` vs session attachments) stay open per the plan — M1
answers the capture-shape half; Expo-class serve commands and budgets land
with M4/M5. Screenshots + bundle JSON kept at `/tmp/babylon-design-m0/`
(spike evidence, not repo artifacts).
