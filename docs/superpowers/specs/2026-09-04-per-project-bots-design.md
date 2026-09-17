# Per-Project Bots Design (2026-09-04)

Bots become the normal thing. No separate "default chat": every project opens
with a default bot, extra bots are staffed per project, and everything runs as
an extension over pi files (oh-my-pi style), never a parallel universe.

## Decision log (locked in brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Conversation home | One shared project chat; default bot is the sole speaker by default |
| 2 | Invoking others | `@`-mention by the user, the default bot, or another bot; extras never speak unasked |
| 3 | Free-speak | Kept: per-project opt-in toggle, default off (mention-only) |
| 4 | App-default bot | Full identity: name, title, persona, model pin |
| 5 | Copy semantics | Snapshot: new projects copy the app-default; existing projects never auto-update |
| 6 | Project identity | Exact folder path (`/repo` and `/repo/sub` are different projects) |
| 7 | Bot scope | Employees: one global identity, staffable to many projects, work chats isolated per project |
| 8 | Storage model | Extension over pi: same JSONL session files in place, zero-copy adoption; Babylon metadata on the side |
| 9 | Round-trip | One-way by default; no export. Going back to pi just works because files stay pi-valid (see record discipline) |
| 10 | Imports | Adopted pi sessions attribute to the project's default bot |
| 11 | Adopted history | Read-only; no continuation in place, no side threads — bridge via handoff file |
| 12 | Handoff consume | `appendCompaction` boundary (keep live history); re-consume allowed, timestamped |
| 13 | Group backfill | Existing groups anchor to `group.cwd ?? first-member cwd`, persisted on first use |

Superseded along the way: separate Babylon storage root, clean-break hiding of
old files, and export-to-pi. All dropped in favor of the extension model.

## Architecture

```
pi session files (sole transcript truth, unchanged format/root)
  └─ opened with exactly one overlay per file (see resolution order)

Babylon metadata (userData side, never in repos):
  bots.json          employees + app-default template + groups  (extended, v3)
  projects/<hash>/   per-project settings: default-bot copy,
                     member roster, free-speak flag
```

Single runtime is unchanged: only the active file streams. Group DMs/rounds
keep the existing `isStreaming` guards and origin-restore behavior.

## Data model (proposed)

`bots.json` v2 → v3, additive only:

- `defaultBot: { name, title?, persona?, model? }` — the app-default template.
  Edited in the Bots panel. Never a roster member, never has chats.
- `Bot` gains `sessionsByProject: Record<projectHash, sessionFile>` — per-project
  chat files. `mainSessionFile` stays as legacy fallback through one helper —
  `botChatForProject(bot, H)`: `sessionsByProject[H]` wins, else legacy
  `mainSessionFile` read-only — replacing the five current readers (`bots-open`,
  DM target path, `findBySessionFile`, `activeBot`, Sidebar/BotsPanel badging).
  `projectHash` = sha1 of normalized absolute cwd via a shared
  `normalizeProjectPath` helper (extracted for main + renderer use from
  `normalizeProjectPathForDispatchEffect`): realpath-resolved (macOS `/private`
  prefixes), no trailing slash, case-folded on case-insensitive volumes.
  Worktree checkouts resolve to distinct hashes — fresh project identity, by design.
- `BotGroup` gains `projectHash: string` — groups belong to exactly one
  project and are filtered by the active project everywhere. Backfill (run once,
  persisted on first use): existing groups anchor to `group.cwd ?? first-member
  cwd`; groups with neither fall back to the active cwd at first open (same chain
  as `ensureGroupRoom`) and persist the anchor.

`projects/<hash>/settings.json`:

```json
{
  "projectPath": "/repo",
  "defaultBot": { "name": "…", "title": "…", "persona": "…", "model": { "provider": "…", "modelId": "…" } },
  "memberIds": ["bot_…"],
  "freeSpeak": false
}
```

Created lazily on first project open by snapshotting the app-default.
Project folders on disk are never touched (no dotfiles).

## Overlay resolution (proposed)

Resolution runs in the main process on every open via `projectSettingsForCwd(cwd)`
(reads `projects/<hash>/settings.json`, snapshotting the app-default on first
open; lightweight in-memory cache). Daemon-owned opens skip it entirely and always
resolve null — rule 4 is a hard guard, not a fallback. For any session file with
project hash H, exactly one overlay applies:

1. File is a member's per-project chat → that member's persona (+ roster).
2. File is a project group room → the room prompt.
3. Otherwise, file lives in project H → H's default-bot copy.
4. No project settings (e.g. daemon-owned or pre-first-open) → no overlay.

Rule 3 is what makes "every chat is default bot" true, including adopted pi
history. Plain/no-overlay sessions effectively disappear once a project is
opened — by construction, not by migration.

## Interaction driver (proposed)

`driveRoomTurns` (`electron/room-driver.ts`) is reused untouched. The change is
orchestration in `pideck:group-send` (`electron/main.ts`): it reads `freeSpeak`
from project settings server-side (group → project) and builds the opening order.
The default bot never enters the driver: its reply IS the ordinary assistant turn
(the user's message prompts normally under the default overlay — no `[Room turn]`
director message is ever written for it). The driver runs only for extras, with
opening order built server-side: quiet mode → mentioned subset in roster order
(empty → driver skipped entirely); free-speak mode → mentioned-first, else full
rotation. A `defaultBotAsMember(settings)` helper is therefore NOT needed for
turns — but the default bot still needs a handle + roster line for `@`-completion
and for other members' `mentionedMembers` routing, synthesized from the project's
default-bot copy. Only `@`-invoked extras go through director prompts. Per-mode behavior:

- `freeSpeak: false` (default): a turn with no `@`-mentions → only the default
  bot replies. Mentioned members speak in roster order; their replies' own
  `@`-mentions pull further members in, bounded by the existing caps.
- `freeSpeak: true`: a turn with no mentions → full member rotation, as today.

`@`-completion in a project offers project members (+ default bot) only.
`PASS` stays the quiet-member protocol; quiet members leave no trace.

## Project settings UI (proposed, new surface)

A "Project" panel (header entry point, not the Babylon settings page):

- Default bot editor: name, title, persona, model pin (edits the project's
  copy only; "reset to app-default" re-snapshots).
- Team: staff/un-staff employees (create-new-staffed-here included),
  per-member model override view (inherited from employee record).
- Free-speak toggle (default off).
- Destructive actions stay confirmed; snapshots keep every change reversible.

App-default editing lives in the existing Bots panel as a "Default bot" section.

## Sidebar / roster (proposed)

- Session rows co-mingle as today (same files) but carry attribution badges:
  default-bot chat, member chat (`@handle`), or room. No more mystery rows.
- Bots shelf scopes to the active project: default bot + staffed members.
  Staffing (add/remove) jumps to the Project panel.
- Composer `@` completes project members only. Global employee directory is
  reachable only from staffing UI — normal chats never see cross-project names.

## pi interop rules (load-bearing)

1. CLI-clean records (verified against pi's `interactive-mode.js`: file-level custom
   *entries* render only with a registered entry renderer, so Babylon's
   `appendCustomMessageEntry` relays are already CLI-invisible; custom *messages*
   render iff `display:true`). Work item: flip exactly four
   `sendCustomMessage(display:true)` writers to `display:false` —
   `babylon_bot_message` (`pi-host.ts:postBotMessage`), `babylon_subagent_activity`
   (`notifySubagentParent`), `babylon_thread_activity` (control + milestone paths),
   `babylon_diagnostics` — AND update Babylon's own `display`-gated readers in
   lockstep (`src/store.ts` rebuild filter, both live `message_start` filters, and
   the companion `message_start` payloads emitted next to each writer), or Babylon
   loses its own relay/activity lines. Fixture test: an annotated file renders
   fully in Babylon and yields zero Babylon lines through pi's `addMessageToChat`
   path. The file-direct entry path (`pi-host.ts:762`) is untouched.
2. Babylon never writes into a file another writer owns mid-stream
   (`isStreaming` guards stay); cross-process reads keep the idle-pull sync.
3. Model pins travel in the file — accepted as harmless.
4. No lock protocol in v1; same-file concurrency is last-writer-wins, same as
   two pi processes today.

## Adopted history + handoff files

Adopted pi history is read-only — no continuation in place, no side threads
("one shared project chat" stays pure). The bridge is **Create handoff**:

- **Author**: the project's default agent using the project's default-bot copy
  (not the cheap title model), so the summary reads in the voice that continues
  the work. Attribution wrapper follows the `[DM from …]` pattern in `botsMessage`.
- **Prompt**: new `buildHandoffPrompt` sibling of `buildRecapPrompt`
  (`electron/recap.ts:78`) via the existing `askCheap` plumbing — larger budget,
  structured shape (goal, key decisions, open loops, files touched). Explicit user
  action only; never the auto-recap sweep.
- **Storage**: sidecar next to `RecapStore` (`electron/recap-store.ts`), keyed by
  source file — never a transcript record, so no reader-filter changes and interop
  rule 1 holds by construction. Each handoff records author, timestamp, and the
  live chat it was consumed into.
- **Consume**: installs the handoff with pi's native `appendCompaction(summary,
  liveLeafId, tokenCounts)` — a real compaction boundary rendered with the existing
  `CompactionCard` vocabulary. No new record type; renders natively in both Babylon
  and the CLI. Re-consume allowed, timestamped, one boundary each.
- **Failure**: summarization failure surfaces inline on the history row (same
  pattern as `sendBotMessage`'s rethrow-keeps-draft-open).

## Migration: none

No file moves, no re-indexing, no import ceremony. First open of a project
creates settings + snapshots the default; existing sessions appear attributed
under rule 3. Legacy `mainSessionFile` values are honored read-only until the
bot's first per-project chat supersedes them.

## Testing

- Unit: overlay resolution order (4 rules) incl. daemon-null guard,
  snapshot-on-first-open, per-project session map read/write via
  `botChatForProject`, mention-subset vs full-rotation driver under both
  `freeSpeak` values, project-scoped completion filtering.
- F1 fixture: annotated file renders fully in Babylon, zero Babylon lines via
  pi's `addMessageToChat` path.
- Handoff: `buildHandoffPrompt` shape, sidecar store round-trip, consume appends
  a compaction boundary readable in both UIs.
- Parity: `bots.json` v2 → v3 load (missing fields default cleanly).
- Suite: `npm run typecheck`, full `vitest` run green.
- Manual: open pi project → attributed correctly; staff second bot → silent
  until `@`; toggle free-speak → rotation; open same file in pi CLI → clean
  transcript.

## Open questions for review

1. Project-settings storage in `userData` (no repo travel) — acceptable, or
   must settings follow the repo?
2. ~~Continuing adopted history~~ RESOLVED: read-only + handoff file consumed via
   `appendCompaction` (keep live history; re-consume allowed, timestamped).
3. Exact-path renames orphan project state (new identity, fresh snapshot) —
   acceptable for v1, or need a rename/relink affordance now?
