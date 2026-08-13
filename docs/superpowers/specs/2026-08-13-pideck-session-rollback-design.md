# PiDeck Session History and Rollback Design

**Date:** 2026-08-13
**Status:** Approved direction; pending final spec review
**Reference:** OpenCode `anomalyco/opencode` at commit `cc4b45612974f735ddec46009ede07729511fba4`

## 1. Purpose

PiDeck will replace its misleading “every turn is a fork point” Session Tree interaction with a history model that distinguishes ordinary linear turns from real conversational branches.

A user may roll a session back from a checkpointed user message. Rollback restores both:

1. the Pi conversation to immediately before that user message; and
2. eligible project files to their state immediately before Pi handled that message.

Example: after five user messages, rolling back from message 3 removes messages 3–5 from the active conversational path and reverses Pi’s eligible filesystem changes from messages 3–5. The abandoned conversation remains preserved in Pi’s append-only session tree.

Rollback is reversible across application restarts until the user sends another message, creates or switches a branch, or otherwise changes the active leaf.

## 2. Product terminology

- **History:** chronological user turns on the active path.
- **Branch:** a real divergence in Pi’s session entries, derived from parent IDs.
- **Checkpoint:** a hidden filesystem tree captured for an eligible user turn.
- **Rollback from here:** move to immediately before a selected user turn and restore subsequent eligible file changes.
- **Undo rollback:** restore the exact pre-rollback active leaf and filesystem state.
- **Commit rollback:** permanently make Undo rollback unavailable after new conversational work begins. It does not delete append-only Pi entries.
- **Fork current session:** create a new Pi session from the latest active leaf.

“Undo” remains available as a slash/command alias, but the visible destructive action uses the more explicit “Rollback from here.”

## 3. OpenCode findings adopted by PiDeck

OpenCode does not reverse tool calls. It maintains an independent hidden Git repository as a content-addressed snapshot store:

- the snapshot repository has its own Git directory and index;
- the actual project is used only as the worktree;
- the user’s visible Git branch and index are not changed;
- source-repository objects may be reused through Git alternates;
- pre-turn tree hashes and per-turn changed paths are persisted;
- rollback restores only paths attributed to the reverted assistant turns;
- the current filesystem tree is captured before rollback so redo can restore it;
- session revert state persists until a new prompt commits it.

PiDeck adopts this filesystem strategy, but not OpenCode’s destructive message cleanup. Pi session files remain append-only. PiDeck uses Pi’s native tree navigation to move the active leaf and leaves the abandoned path intact.

## 4. Supported scope

### 4.1 Exact filesystem rollback

Initial exact filesystem rollback is available only when all of the following are true:

- the active project belongs to a valid Git worktree;
- snapshot tracking is enabled;
- PiDeck recorded a complete checkpoint for the selected boundary and every later active-path turn;
- the session is owned by the active PiDeck runtime and is idle;
- the checkpoint store and relevant objects are readable;
- the active path has not changed since the rollback preview was prepared.

Older turns created before this feature have no checkpoint. They show **Filesystem checkpoint unavailable** and cannot be rolled back. PiDeck never offers conversation-only rollback as a substitute.

Non-Git projects show **Rollback requires a Git project**. They retain normal conversation history and current-session forking.

### 4.2 Snapshot exclusions

PiDeck follows source Git ignore rules and does not snapshot ignored paths. The implementation may impose a bounded size limit on untracked files, matching OpenCode’s safety model.

A checkpoint is marked incomplete when PiDeck knows an assistant turn changed an excluded path. Any rollback range containing an incomplete checkpoint is unavailable rather than partially presented as exact.

The confirmation preview explicitly lists covered files and any known exclusions.

### 4.3 Turn boundaries

A rollback checkpoint belongs to a user message that starts an idle Pi agent turn.

- Normal prompts are checkpointed.
- A queued follow-up is checkpointed when it becomes the next active turn.
- Mid-stream steer messages are part of the already-running turn and do not create an independent filesystem boundary. The History UI labels such messages as part of the containing turn rather than offering rollback from the steer message itself.
- Extension-generated or synthetic user messages are not rollback boundaries unless the owning runtime explicitly registers them as such.

## 5. History and branching UI

### 5.1 Sidebar and context workspace

Rename **Session tree** to **History** in the sidebar. Opening it retains the current middle session and uses the existing contextual workspace.

For a linear session, History is a chronological list of user turns. It is not rendered as an indented tree.

Each row contains:

- turn number;
- user-message summary;
- short assistant-result summary when available;
- checkpoint state;
- current-position state;
- branch count only when the turn is a real divergence.

Selecting a row is read-only and opens a detail preview. Selection never mutates the session.

### 5.2 Rollback action

An eligible historical user turn exposes **Rollback from here** in two locations:

- the selected History detail; and
- the user-message hover/focus actions in the primary transcript.

The action is unavailable with a specific explanation when the session is streaming, the project is non-Git, the checkpoint is absent/incomplete, or the target is not on the current active path.

The confirmation surface states:

- the selected user text;
- how many user turns leave the active path;
- how many files will be added, modified, or removed;
- that the abandoned conversation is preserved;
- that sending new text makes Undo rollback unavailable;
- known excluded paths, if any.

No rollback occurs until the preview is generated and the user confirms.

### 5.3 Real branches

Only real parent-ID divergence renders as a tree. Alternate paths are visually marked as current or abandoned without relying on color alone.

Rollback does not erase the abandoned path. Once the user sends a replacement message, the new entry becomes another real child of the rollback point and History can show the divergence.

### 5.4 Forking

Remove **Fork from here** from historical History rows.

Expose **Fork current session** as a session-level action at the latest active leaf. It uses Pi’s existing session-fork/clone path to create a separate session file. It never silently moves the current session’s leaf.

Historical experimentation uses Rollback followed by a replacement prompt, which creates a preserved branch in the current session. Isolated experimentation continues to use a worktree.

## 6. Rolled-back state

After rollback:

- the primary transcript renders only the newly active path;
- the selected original user message is restored into the composer for editing;
- a persistent recovery dock appears directly above the composer;
- the dock states how many messages and files were rolled back;
- the dock can expand to show the abandoned user turns and file summary;
- its primary action is **Undo rollback**.

The first version restores the entire rollback in one operation. It does not implement OpenCode’s incremental message-by-message redo.

The recovery dock persists across restart because rollback state is stored durably outside renderer memory.

## 7. Undo rollback eligibility

Undo rollback is enabled only when all checks pass:

1. the current session file matches the recorded session;
2. the active leaf equals the recorded rollback leaf;
3. no new session entry has been appended from the rollback position;
4. no branch navigation, fork, compaction, model-generated summary, or extension mutation changed the active path after rollback;
5. the saved pre-rollback filesystem snapshot is available;
6. the set of selectively restored paths is unchanged in the rollback record;
7. no agent turn is running.

Opening/closing context panes, switching themes, quitting PiDeck, or reopening the same untouched session does not invalidate Undo rollback.

When eligibility is lost, PiDeck commits the rollback record before accepting the mutating operation. The recovery dock disappears and the old path remains available only as normal session ancestry.

## 8. Filesystem snapshot architecture

### 8.1 Store location

Snapshot objects live outside the project, under the PiDeck application state directory:

```text
<pideck-state>/snapshots/<project-key>/<worktree-key>/
```

- `project-key` identifies the resolved Git common directory.
- `worktree-key` identifies the resolved worktree path.
- linked worktrees receive distinct snapshot indexes while safely reusing source object storage where possible.

Rollback metadata lives under:

```text
<pideck-state>/rollbacks/<session-id>.json
```

No snapshot metadata is written into the user’s source tree or visible Git index.

### 8.2 Snapshot operations

A bounded `SnapshotStore` service provides:

- `capture(cwd) -> treeId | unavailable`;
- `changedFiles(fromTree, toTree) -> paths`;
- `previewRestore(path -> treeId) -> structured diffs`;
- `restore(path -> treeId)`;
- `cleanup()`.

Every Git invocation sets an explicit hidden `--git-dir` and project `--work-tree`. Path inputs are project-relative, literal, NUL-delimited where supported, and containment-validated.

### 8.3 Per-turn record

A durable `TurnCheckpoint` contains:

```ts
interface TurnCheckpoint {
  sessionId: string;
  sessionFile: string;
  userEntryId: string;
  parentLeafId: string | null;
  finalLeafId: string;
  beforeTree: string;
  afterTree: string;
  changedPaths: string[];
  complete: boolean;
  exclusions: string[];
  createdAt: string;
}
```

The record is associated with real Pi entry IDs, never transcript array indexes.

### 8.4 Rollback record

```ts
interface ActiveRollback {
  version: 1;
  sessionId: string;
  sessionFile: string;
  targetUserEntryId: string;
  rollbackLeafId: string | null;
  previousLeafId: string;
  previousEntryIds: string[];
  redoTree: string;
  restoredPaths: string[];
  abandonedUserEntryIds: string[];
  createdAt: string;
  state: "active" | "committed";
}
```

`previousEntryIds` is a bounded integrity fingerprint or digest in the implementation; it is shown expanded here for clarity.

## 9. Runtime data flow

### 9.1 Prompt checkpointing

Before an eligible prompt begins:

1. ensure the owning session is idle and stable;
2. capture the current Pi leaf and entry revision;
3. capture the hidden Git tree;
4. accept the prompt;
5. resolve the actual persisted user entry ID;
6. after the turn settles, capture the ending tree;
7. compute changed paths and persist the checkpoint atomically.

Checkpoint capture is serialized with prompt admission, not held across the entire agent turn. Existing steer/follow-up/abort responsiveness remains intact.

### 9.2 Rollback preview

1. verify target membership on the active path;
2. collect checkpoints from the target user entry through the active leaf;
3. for each changed path, select the earliest `beforeTree` that contains its pre-change state;
4. capture the current tree for Undo rollback;
5. generate a selective restore preview;
6. return a revision-stamped plan to the renderer.

The plan expires if the session leaf, entries, runtime state, or filesystem tree changes before confirmation.

### 9.3 Rollback commit

1. revalidate the plan and require an idle runtime;
2. write a pending rollback record;
3. selectively restore files;
4. call Pi’s `navigateTree(targetUserEntryId, { summarize: false })`;
5. verify Pi placed the leaf at the target user entry’s parent and returned its editor text;
6. persist the active rollback record atomically;
7. rebuild the primary transcript and populate the composer.

If filesystem restore succeeds but tree navigation fails, restore the captured redo tree for the affected paths. If tree navigation succeeds but file restoration is later found invalid, navigate back to the previous leaf and restore the redo tree. A failed operation never advertises success with only half the state changed.

### 9.4 Undo rollback

1. revalidate all eligibility conditions;
2. restore `restoredPaths` from `redoTree`;
3. navigate Pi to `previousLeafId` with summarization disabled;
4. verify the leaf and transcript;
5. clear the active rollback record.

Compensation reverses the first half if the second half fails.

## 10. IPC contract

Renderer APIs are structured and revision-stamped:

```ts
getHistory(): Promise<HistoryProjection>;
prepareRollback(userEntryId: string): Promise<RollbackPlan>;
commitRollback(planId: string, revision: string): Promise<RollbackResult>;
undoRollback(revision: string): Promise<RollbackResult>;
forkCurrentSession(): Promise<ForkResult>;
```

The renderer never issues Git commands, edits session files, or sends rollback through slash-command string concatenation.

IDs, paths, snapshot hashes, payload sizes, and active ownership are validated in Electron. Rollback is rejected while streaming or when the loaded runtime does not own the session.

## 11. Persistence and cleanup

- Metadata writes use temporary-file plus atomic rename.
- Snapshot object cleanup runs periodically and retains all trees referenced by turn checkpoints or active rollback records.
- Unreferenced objects are pruned after a retention window.
- Deleting a session may remove its checkpoint metadata after confirming no active rollback depends on it.
- Corrupt or missing metadata disables rollback and leaves normal session use unaffected.
- PiDeck never runs destructive Git commands against the user’s visible repository.

## 12. Error behavior

Errors are explicit and non-destructive:

- **Rollback requires a Git project**
- **No filesystem checkpoint was recorded for this turn**
- **This checkpoint is incomplete because excluded files changed**
- **The session changed; review the rollback again**
- **Finish or stop the active response before rolling back**
- **Undo rollback is no longer available because the session continued**
- **Snapshot data is missing or damaged**

A failed checkpoint does not fail the agent turn. It records that rollback is unavailable for that boundary.

## 13. Accessibility and interaction

- Rollback actions are reachable on keyboard focus, not hover-only.
- Eligibility is represented by text and icon, not color alone.
- Confirmation focus is trapped and restored.
- The recovery dock uses a status announcement when rollback completes.
- Destructive confirmation names the selected user message and file count.
- Reduced motion uses opacity-only transitions.
- “Undo rollback” remains in a stable location directly above the composer while eligible.

## 14. Testing

### Snapshot service

- hidden repository never changes the visible branch, HEAD, or index;
- tracked, untracked, added, deleted, renamed, symlink, and binary files restore correctly;
- ignored, oversized, out-of-scope, and path-escape cases fail closed;
- linked worktrees use isolated indexes;
- spaces, Unicode, leading colons, and newline-like path edge cases are safe;
- missing Git and corrupt object stores disable rollback without data loss.

### Checkpointing

- baseline capture happens before tool execution;
- final capture is associated with the correct user entry ID;
- queued follow-ups receive boundaries when activated;
- mid-stream steer does not claim an independent checkpoint;
- checkpoint failure does not block normal prompting;
- stale session events cannot attach a checkpoint to another session.

### Rollback

- rolling back message 3 from five messages activates the state before message 3;
- files changed by messages 3–5 are restored to their earliest pre-message-3 state;
- files unaffected by those turns remain untouched;
- files created after the target are removed;
- old conversation entries remain in the Pi tree;
- target text returns to the composer;
- preview revisions reject stale confirmation;
- compensation restores both domains after partial failure.

### Undo rollback

- undo restores the old leaf and pre-rollback filesystem state;
- undo survives restart;
- opening context or changing theme does not invalidate it;
- sending text, branching, compacting, or changing the leaf commits it;
- unavailable undo never performs partial restoration.

### UI

- linear history has no fake branch indentation;
- actual divergence renders as branches from real parent IDs;
- historical rows say Rollback, not Fork;
- Fork current session operates only from the latest leaf;
- older/non-Git/incomplete turns explain why rollback is unavailable;
- recovery dock is readable in light/dark and narrow layouts.

### Regression

- existing prompts, images, steer/follow-up, abort, compaction, extension dialogs, model controls, workflows, threads, subagents, native branching, and worktrees remain functional;
- 1,500-level session IPC remains flat and safe;
- typecheck, unit tests, production build, security audit, and Electron smoke launch pass.

## 15. Out of scope

- exact rollback for non-Git projects;
- best-effort reconstruction for turns without checkpoints;
- restoring ignored or intentionally excluded files while claiming completeness;
- incremental message-by-message redo in the first version;
- deleting abandoned entries from Pi’s append-only session file;
- merging workflow dependencies into session history;
- live rollback while an agent turn is running;
- renderer ownership of filesystem or session mutation.

## 16. Acceptance criteria

The feature is complete when a checkpointed Git session with five linear user turns can safely roll back from turn 3, restore the conversation and eligible filesystem to immediately before turn 3, survive an app restart with Undo rollback available, undo back to the exact prior leaf and file state, and permanently remove Undo rollback after any new message or branch mutation—without modifying the user’s visible Git branch/index or deleting Pi session history.
