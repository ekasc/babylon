# Project audit — 2026-09-06

## Result

**9 findings: 3 high, 6 medium.** No application fixes were made. No subagents were used.

All **894 tests across 146 files passed**. Type checking and the production build passed. The findings below identify gaps that those checks did not catch.

## Scope

Reviewed Electron lifecycle/preload and IPC trust checks, daemon/remote transports, permission evaluation and persistence, Git file operations, snapshot path protections, renderer Markdown/diagrams, build scripts, and CI. Followed relevant call sites and tests. Critical assets are source files, conversation history, execution permissions, and runtime authority; boundaries include model tool calls, renderer IPC, socket requests, persisted settings, and filesystem paths.

Isolated probes used temporary files and ephemeral loopback servers, without contacting a live daemon or changing user permission settings. “Reproduced” means exercised against project code; “source-confirmed” means established from implementation without desktop interaction. This is a targeted audit, not exhaustive certification.

## Findings

### A01 — High: Optional daemon TCP mode has no authentication

**Evidence:** `daemon/main.ts:42`; `src/daemon-server.ts:347,701–742`.

The daemon accepts administrative and Pi requests immediately after connection. Its Unix socket receives owner-only permissions, but the optional `BABYLON_DAEMON_PORT` loopback listener has no equivalent authentication.

Another local OS user who can reach that port can change execution mode to `full_access`, read runtime state, and access the Pi RPC surface. This finding applies to optional TCP mode; the default Unix socket is restricted, and the entry point does not expose TCP on all network interfaces.

**Reproduced:** An isolated server accepted `permissions.set-mode` as the first request from an unauthenticated connection and acknowledged `{"mode":"full_access"}`.

**Fix:** Remove unauthenticated TCP support or require owner-provisioned credentials before state access or mutation. Test both unauthenticated rejection and authenticated administration.

### A02 — High: Daemon session approvals leak across sessions

**Evidence:** `daemon/main.ts:62–67`; `src/daemon-server.ts:244–263`; `electron/permissions.ts:303–306,480–516`.

The daemon adapter drops the session identifier during evaluation, approval, and cleanup. Pending approval records have no owner, and `applyApproval` creates session rules without an identifier. `ruleApplies` treats missing identifiers as globally applicable.

“Allow for this session” therefore permits the same action in unrelated concurrent sessions. Session denial and cleanup also cross boundaries. The local Electron adapter already forwards identifiers, so behavior differs by runtime owner.

**Reproduced:** Created an `allow_session` rule through `applyApproval` in supervised mode, then evaluated that command for `unrelated-session`. It was allowed by the explicit rule. Source tracing confirms the daemon uses this path.

**Fix:** Preserve the owning session through evaluation, pending approvals, resolution, and cleanup. Require ownership for session rules and test two concurrent sessions.

### A03 — High: Shell categorization can bypass explicit denies

**Evidence:** `electron/permissions.ts:187–196,247–248,309–337`; `electron/permission-agent.ts:56–64`.

A shell command receives only one category, selected in priority order. Deny rules match only that exact category even when a command has several effects.

For example, a rule denying `git_push` matches an ordinary push, but adding the force flag changes the category to `shell_destructive`. Full Access then permits it unless another deny matches the destructive category. A compound installation-and-push command instead receives `package_install`. This contradicts the engine's stated invariant that explicit denies survive Full Access.

**Source-confirmed:** Traced the categorizer, mapper, matcher, and Full Access branch. No destructive or remote Git command was executed for this finding.

**Fix:** Check applicable denies across all detected effects before allowing execution. Define treatment of compound shell syntax and avoid representing category heuristics as a complete execution sandbox. Add pure evaluator regressions for overlapping categories.

### A04 — Medium: Permission persistence fails silently

**Evidence:** `electron/permissions.ts:379–407,445–460`; `electron/main.ts:1926`.

`persist()` discards write failures. Consequently, `setModeAndPersist()` resolves successfully when nothing was saved; permanent rule edits also launch persistence without awaiting it. Load failures silently fall back to default state.

The UI can acknowledge supervised mode or a permanent deny that disappears after restart. A new engine defaults to `auto`, permitting actions the user expected to require approval. Settings writes also lack atomic replacement and serialization.

**Reproduced:** Used a regular temporary file as the permission directory. Setting supervised mode resolved successfully, while a newly loaded engine reported `auto`.

**Fix:** Surface persistence failures, await durable changes before acknowledging success, serialize atomic replacement, and distinguish missing settings from unreadable/corrupt policy. Test write failures and restart recovery.

### A05 — Medium: Git status truncates tracked filenames with spaces

**Evidence:** `electron/git.ts:189–205,283,314,927–961`.

Ordinary porcelain-v2 records are split on all whitespace, and their last token becomes the path. Output is not requested with NUL delimiters. File actions also trim meaningful filename whitespace.

A modified `src/my file.ts` becomes `file.ts`. Diff/staging operations fail or act on a different existing file; discarding can affect the wrong file if the truncated name exists.

**Reproduced:** Extracted and transpiled the actual parser. Input `1 .M N... 100644 100644 100644 abc def src/my file.ts` returned `file.ts`. No repository Git mutation was used in this probe.

**Fix:** Parse NUL-delimited records at their defined field boundaries, preserve exact filenames, and use literal pathspecs for single-file actions. Cover spaces, tabs, newlines, edge whitespace, and renames.

### A06 — Medium: Pending daemon approvals cannot recover after reload

**Evidence:** `electron/main.ts:1996–2004`; `src/daemon-server.ts:244–254`; `src/App.tsx:674,705`.

The renderer queries pending approvals during recovery, but the IPC handler returns an empty array in daemon mode. The daemon retains approval promises while broadcasting requests only as live events; pending requests are absent from its state snapshot.

Reloading/reopening the GUI, or disconnecting while an approval is raised, leaves the agent waiting on an invisible request until the default 15-minute denial timeout.

**Source-confirmed:** Traced renderer recovery, the IPC branch, pending storage, and timeout. Desktop reload was not exercised.

**Fix:** Expose daemon pending approvals and reconcile them on attach/reconnect, including resolution and expiry. Test approvals raised while the renderer is detached.

### A07 — Medium: Invalid hook registration crashes the daemon

**Evidence:** `src/daemon-server.ts:621–635,675–695`; `src/hooks.ts:38–42`.

Hook registration runs outside the Pi request error boundary. A nonpositive timeout throws, and socket dispatch does not catch handler exceptions; decoding and envelope parsing have narrower catches.

A malformed client request terminates the process and interrupts sessions. Optional TCP mode also makes this reachable by other local users, as described in A01.

**Reproduced:** A disposable daemon-module process received a valid `hooks.register` envelope with `timeoutMs: -1`. It exited with code 1 and an uncaught “invalid timeoutMs” error from registration.

**Fix:** Validate payloads and convert request-handler failures into protocol errors. Test that invalid registration returns an error and the server still answers a subsequent ping.

### A08 — Medium: Shipped CSP prevents PlantUML rendering

**Evidence:** `src/components/PlantUmlBlock.tsx:25–33`; `src/components/Markdown.tsx` PlantUML branch; `index.html:7`.

The component requests its image from the public PlantUML server, while `img-src` permits only self, data, and blob sources. Diagrams therefore fall back to raw source even online, with an inaccurate offline/invalid-input explanation.

**Source-confirmed:** Compared the component URL with the shipped policy. No private content was sent to an external service and no browser reproduction was performed.

**Fix:** Prefer local rendering, or make remote rendering an explicit user choice with a narrowly compatible policy. Merely allowing the host would send diagram text from conversations to that third party, which is currently blocked. Verify the input encoding as part of the rendering fix.

### A09 — Medium: Unauthenticated remote clients prevent shutdown

**Evidence:** `src/remote-server.ts:112–114,215–232,261–264`.

Sockets enter the sessions map only after successful authentication. Shutdown destroys only mapped sockets before awaiting server closure. An idle unauthenticated connection remains open without a timeout.

This prevents graceful shutdown for consumers of the remote server module. No production startup call to `startRemoteServer` was found outside that module, so this is a latent module defect rather than confirmed default desktop exposure.

**Reproduced:** Connected an idle unauthenticated client, invoked shutdown, and observed it still pending after 100 ms. It completed after explicitly destroying the client. Source inspection confirms no idle deadline or shutdown cleanup covers that connection.

**Fix:** Track every accepted socket independently of authentication, destroy all connections during shutdown, and bound unauthenticated lifetimes. Test idle and rejected-authentication clients.

## Verification

| Check | Result |
| --- | --- |
| `pnpm test` | Passed: 146 files, 894 tests, 19.57 seconds reported by Vitest. |
| `pnpm typecheck` | Passed, exit 0. |
| `pnpm build` | Passed, exit 0: types, renderer, Electron main/preload, daemon. |
| Isolated module probes | Reproduced A01, A02, A04, A05, A09. |
| Invalid-request subprocess | Reproduced A07; expected defect exit 1. |
| Lint/format | No dedicated script or ESLint/Prettier/Biome configuration found; no ad hoc formatter applied. |
| Desktop smoke/live model | Not run; UI interactions, providers, and packaged startup remain unverified. |
| Dependency advisory scan | Not performed; current vulnerability coverage is unknown. |

Local Node was **22.16.0**, below README's Node 24 requirement; CI also selects Node 22. Results establish behavior in this environment, not the documented runtime.

Build warnings included an invalidly positioned external-font CSS import, mixed static/dynamic imports of the bridge, and chunks exceeding 500 kB. These are observations, not measured runtime-performance findings. CI still describes Pi as undeclared and installs global version 0.84.3, while package.json pins 0.84.1 and the current link script prefers the declared dependency unless explicitly overridden. Align documentation and CI with the intended runtime and SDK.

Positive controls reviewed include renderer sandbox/context isolation, trusted IPC senders, navigation restrictions, strict Mermaid rendering, bounded frames, and snapshot path/symlink validation. Existing snapshot/rollback tests also passed. These do not negate the findings above.

Temporary evidence: `/tmp/native-audit-tests.log`, `/tmp/native-audit-types.log`, `/tmp/native-audit-build.log`, `/tmp/native-audit-probes.log`, `/tmp/native-audit-crash.log`. Probe scripts: `/tmp/native-audit-probes.mjs` and `/tmp/native-audit-crash.mjs`. Temporary files may be removed by the OS. An initial probe had a dependency-resolution error; bundling dependencies corrected the harness before the successful run.

An execution hook rejected destructive-looking text in an initial probe and report-writing attempt. The restricted command text was omitted; A03 was assessed from source. No approval was requested or restricted operation executed.

Only this report was added as a deliverable; the build regenerated its normal ignored output directories. No fixes, dependency changes, commits, branches, pushes, releases, or deployments were made.

## Suggested order

Address A01–A03 first, then durable permissions and daemon failure/recovery (A04, A06, A07). Fix A05 before relying on file-specific discard. Resolve A08–A09 afterward, with focused regression coverage for each behavior.
