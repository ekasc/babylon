# Audit: Per-Project Bots Design (spec 2026-09-04)

## Context

The spec (`docs/superpowers/specs/2026-09-04-per-project-bots-design.md`) makes
bots the normal thing: per-project default bot, staffable employee bots,
mention-only by default with a free-speak toggle, all as an extension over pi
files (zero-copy adoption, no separate storage). This audit checks each
load-bearing claim against the current code and names what the plan
understates or leaves open.

## Verified against code (holds up)

- Serial driver exists and is testable: `electron/room-driver.ts`
  (`driveRoomTurns`, caps default 3 rounds / 10 turns) + `electron/room-driver.test.ts`.
  Mention routing (`mentionedMembers`, roster order, no-self) lives in `src/bots.ts`.
- Overlay-by-file pattern exists: `overlayForSessionFile` in `electron/main.ts:177`
  (bot → group → null). Rule 3 (project-default fallback) is a clean extension.
- `bots.json` v2 save with `{ version: 2, bots, groups }` (`electron/bots.ts:239`);
  v3 additive fields (`defaultBot`, `sessionsByProject`, `projectHash`) default cleanly.
- Director-prompt collapse + `PASS` dropping already implemented in
  `src/store.ts:messagesToItems`; `roomTurn` presence is ephemeral. Mention-only
  rendering needs no store changes.
- Daemon guards on all bot/group IPC already exist (bot features need local runtime).

## Findings (by severity)

### F1 [P0] — CLI-clean record rule is a coupled change, stated as one line
Spec §"pi interop rules" rule 1 says: extend display/sidecar discipline to
bot-message relays and activity lines. But today:
- Writers use `display: true`: `babylon_bot_message` (`electron/pi-host.ts:1619-1635`,
  incl. the live `message_start` event), `babylon_subagent_activity` (`:1589`,
  plus file-direct append at `:762`), `babylon_thread_activity` (`:1557`),
  `babylon_diagnostics` (`:1694`).
- Babylon's own readers **require** `m.display`: `src/store.ts:293` (rebuild path),
  `:460` and `:465` (live `message_start` path).

Flipping writers to `display:false` without touching the three reader filters
silently deletes Babylon's own relay/activity lines. VERIFIED against pi
sources (`@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`):
- File-level custom *entries* (`appendCustomMessageEntry`, e.g. the promoted-child
  relay at `electron/pi-host.ts:762`) are CLI-safe already — `addCustomEntryToChat`
  (`:2910`) returns early without a registered entry renderer, and pi will never
  have renderers for `babylon_*` types. No change needed there.
- Custom *messages* (`sendCustomMessage`, persisted to the file) render in pi's CLI
  iff `message.display` (`addMessageToChat`, `case "custom"`). Babylon persists
  THREE such types with `display:true`: `babylon_bot_message` (`pi-host.ts:1619-1635`),
  `babylon_subagent_activity` (`:1583-1600`), `babylon_thread_activity` (`:1527`,
  `:1550-1575`), plus `babylon_diagnostics` (`:1689-1694`, same treatment). All
  four WILL render as generic lines in pi's TUI today. Verdict: LAUNCH-BLOCKING
  but narrowly scoped — flip exactly these writers to `display:false` (keeping the
  file-direct entry path as-is), update Babylon's `m.display`-gated readers
  (`src/store.ts:~293 rebuild, :460 + :465 live`, plus the `display:true` payloads
  in the companion `message_start` events emitted next to each writer), and add a
  fixture test: Babylon-annotated file renders fully in Babylon AND shows zero
  Babylon lines in pi's `addMessageToChat` path.

### F2 [P1] — Driver "one behavior change" understates the orchestration delta
`driveRoomTurns` itself is reusable untouched, but the change is in
`pideck:group-send` (`electron/main.ts:~1000-1035`): today no-mention means
*full member rotation*; the spec needs no-mention + `freeSpeak:false` to mean
*default bot only*. That requires: thread `freeSpeak` from project settings
into the handler (lookup server-side by group → project), build
`order = [defaultBot, ...mentioned]` in quiet mode, and define the default
bot's reply as a **normal assistant turn** (no director prompt) vs a room turn.
RESOLVED during spec patch: the default bot never enters the driver at all —
quiet + no mentions skips the driver entirely; quiet + mentions drives the
mentioned subset only. `defaultBotAsMember(settings)` survives repurposed:
handle + roster line for `@`-completion and `mentionedMembers` routing only.

### F3 [P1] — Overlay rule 3 needs a named lookup on every open path
Rule 3 ("any file in project H → H's default copy") means `pideck:open-session`
must resolve project settings per open (by cwd) in the main process, not just
the `botId`/`path` branches at `main.ts:820-833`. The plan names no function,
store, or cache for this (`projectSettingsForCwd(cwd)` + lazy snapshot on
first open). Daemon-owned opens must keep returning null (rule 4) — state the
guard explicitly or rule 3 will look like it leaks overlays into daemon mode.

### F4 [P1] — `projectHash` normalization is unspecified
`sha1(resolved absolute cwd)` breaks on macOS symlink prefixes (`/private`),
trailing slashes, and case-insensitive volumes; worktree checkouts get fresh
identities (probably desired — say so). There is a possible reuse:
`normalizeProjectPathForDispatchEffect` in `src/App.tsx` — verify it fits main
process use or extract a shared `normalizeProjectPath` into `src/` for both.

### F5 [P2] — Legacy `mainSessionFile` precedence + group backfill
Readers of `mainSessionFile`: `electron/main.ts` (`bots-open`, DM target path),
`electron/bots.ts:findBySessionFile`, `src/App.tsx:activeBot`, Sidebar badging,
`BotsPanel`. The plan says "honored read-only until superseded" — pin the
precedence (`sessionsByProject[H]` wins; else legacy) in one helper to avoid
five divergent checks. Group backfill RESOLVED by user: existing groups anchor
to `group.cwd ?? first-member cwd`. Groups with neither fall back to the active
cwd at first open — same fallback chain as `ensureGroupRoom`
(`electron/main.ts:972`) — and persist the anchor on first use so the rule runs
once, not per open.

### F6 [P2] — Spec open-Q2 RESOLVED: read-only history + handoff file (no side threads)
User decision: adopted history files cannot be continued in place. Instead, offer
**Create handoff**: the project's default agent summarizes the old thread into a
handoff file, which then seeds the live chat. Consequences for the spec:
- The "one shared project chat" model stays pure — no threads list, no DM-style
host switching under a stationary view, no "agent is busy" contention from imports.
- New work item H1: handoff authoring + storage + consume action (see F8).
- "Continue" affordance on adopted history is replaced by "Create handoff"
  (always available) — the fresh/empty-live distinction disappears.

### F7 [P3] — Default-bot reply mechanics unstated
Confirm: in quiet mode the default bot answers as the ordinary assistant turn
(the user's message prompts normally; no `[Room turn]` director message is
written for it). Only `@`-invoked extras go through director prompts. One
sentence in the spec settles it.

### F8 [P2] — Handoff file needs authoring, storage, and consume semantics
Work the spec must name:
- **Author**: default agent with the *project's* default-bot copy (not the cheap
  title model) — the handoff should read in the voice/persona that will continue
  the work. Reuse the prompt-wrapper pattern from `botsMessage`
  (`electron/main.ts:~1075`: `[DM from …]` prefix) for attribution.
- **Summarizer plumbing**: reuse `askCheap` + a `buildHandoffPrompt` sibling of
  `buildRecapPrompt` (`electron/recap.ts:78`), with a larger budget and a
  structured shape (goal, key decisions, open loops, files touched). NOT the
  auto-recap sweep — handoffs are explicit user actions only.
- **Storage**: sidecar next to `RecapStore` (`electron/recap-store.ts`, per-file
  keyed), never a transcript record — keeps interop rule 1 intact and needs no
  reader-filter changes (unlike F1). Handoff lists per source file; each records
  author (project default name), timestamp, and the live chat it was consumed into.
- **Consume**: explicit user action installs the handoff as a **compaction-style
  summary boundary** in the live project chat (user: "like a session got
  compacted"). Renders with the existing `CompactionCard` vocabulary
  (`src/components/ChatView.tsx`) so it reads as a context boundary, not a chat
  message. Never a quoted user bubble. Re-consuming the same handoff twice:
  allowed, timestamped, each a new boundary (cheap and honest).
  Open mechanism choice VERIFIED to two native candidates (pi `session-manager.d.ts`):
  (a) `appendCompaction(summary, firstKeptEntryId, tokensBefore, …)` — a real
  compaction boundary; pi renders it (`renderSessionEntries` handles compaction
  entries) and treats it as context. Needs a live leaf id + token counts, both
  available at consume time. (b) `branchWithSummary(branchFromId, summary, …)` —
  starts a new branch with the summary, abandoning the prior path from context
  (still in file). The product edge below picks between them; (a) is the recommended
  default (empty live chat makes them equivalent). Either way NO new
  record type and NO reader-filter changes — pi-native entries render in both
  Babylon and pi CLI by construction.
- **Failure**: summarization failure surfaces inline on the history row (same
  pattern as `sendBotMessage` rethrow-keeping-draft-open in `src/App.tsx`).

## What's solid (keep)

Additive v3 schema, snapshot semantics (no migration code at all), reusing
`driveRoomTurns` + its tests, overlay-by-file extension, mention-only rendering
already built, daemon guards already in place.

## Approach (recommended audit-driven path)

1. Resolve the two product calls below (threads ✓ handoff; group backfill ✓).
2. pi-CLI rendering self-verified: F1 is LAUNCH-BLOCKING, scoped to the four
   `sendCustomMessage(display:true)` writers + Babylon reader filters (done).
3. Rewrite the flagged spec sections (F1 work item, F2 orchestration +
   `defaultBotAsMember`, F3 lookup + daemon guard, F4 normalization + reuse,
   F5 precedence helper, F7 one-liner), then submit for review.

## Files to modify (when planning lands)

- Spec only for now: `docs/superpowers/specs/2026-09-04-per-project-bots-design.md`
- Referenced (not touched in plan mode): `electron/pi-host.ts`, `src/store.ts`,
  `electron/main.ts`, `electron/room-driver.ts`, `electron/bots.ts`, `src/bots.ts`,
  `src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/BotsPanel.tsx`

## Reuse (confirmed candidates)

- `driveRoomTurns` + `electron/room-driver.test.ts` (driver untouched)
- `mentionedMembers`, `roomTurnPrompt`, `parseRoomTurn`, `isPassReply` (`src/bots.ts`)
- `overlayForSessionFile` pattern (`electron/main.ts:177`)
- Possibly `normalizeProjectPathForDispatchEffect` (`src/App.tsx`) for F4

## Steps

- [x] Skeleton audit + code verification of load-bearing claims
- [x] User answers: no side threads — handoff file instead (F6 resolved, F8 added)
- [x] User answers: group backfill = `group.cwd ?? first-member cwd` (F5 resolved)
- [x] User answers: handoff consume default → locked (a) `appendCompaction` per approved plan
- [x] Self-verify pi-CLI custom-message rendering; split F1 accordingly
- [x] Patch spec sections F1–F5, F7; re-check contradictions (incl. F2/F7 driver-order fix: default never enters driver)
- [x] Submit revised spec for review (waived by user order to implement; spec is the build source as approved)

## Implementation record (per user "just implement the plan")
Layers built + verified (`tsc` clean, suite 131 files / 778 tests green):
1. Pure model (`src/bots.ts`): `DefaultBot` + `validateDefaultBot` + `defaultBotHandle`,
   `sessionsByProject` / `projectHash` fields, `botChatForProject` (single precedence),
   `groupAnchorCwd`, `buildDefaultBotSystemPrompt`. Deviation: hash computed main-side
   only (renderer has no realpath) — no shared hasher.
2. Stores: `bots.json` v3 (`defaultBot`, additive; `FALLBACK_DEFAULT_BOT` = Assistant),
   `setProjectSession` / `findByProjectSessionFile`, new `ProjectSettingsStore`
   (`projectHashForCwd` = sha256(realpath(normalize))/24, snapshot-on-first-open).
3. Main: `projectSettingsForCwd`, overlay rule 3 + daemon hard guard, group anchor
   persist, group-send quiet-skip + freeSpeak, bots-open/DM per-project paths,
   shared-chat extras in `pideck:prompt` (staff-gated, zero behavior change otherwise),
   10 new IPC handlers.
4. F1: four `sendCustomMessage` writers → `display:false` + Babylon readers match by
   `customType` (both flag values render); diagnostics had no Babylon reader (pure win).
5. Handoff: `buildHandoffPrompt`/`normalizeHandoffText`/`transcriptText` (director
   prompts dropped), sidecar `HandoffStore`, `summarizeHandoff`/`consumeHandoff`/
   `emitHandoffEvent`, create/list/consume IPC, `babylon_handoff_consumed` →
   CompactionCard. Compromise recorded: voice via persona-in-prompt on the cheap
   model (per audit's askCheap reuse), not a full-agent turn.
6. Renderer: bridge/preload surface, `showSpeakers` (headers without hiding thinking),
   project settings state, map-aware `activeBot`, staffed `@` completion, attribution
   badges, scoped shelf + default row + group filter, handoff row-menu actions,
   BotsPanel default section, new ProjectPanel (default editor + reset, team hire/
   staff, free-speak), header Project entry.
Open product items left (unchanged): spec Q1 (userData settings travel), Q3 (rename
orphans). `mainSessionFile` dual-tracking: map-only writes; legacy kept read-only.

## Verification

- Every finding above links to a file:line verified this pass.
- Final spec must contain: F1 work item (writer+reader+test), F2 orchestration
  owner, F3 lookup name + daemon guard, F4 normalization + reuse verdict, F5
  precedence helper + backfill rule, F7 default-reply sentence, F6/F8 handoff
  (author, store, consume), Q2 resolved.
- `plannotator_submit_plan` only after user answers below.
