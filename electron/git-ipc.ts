import type { IpcMainInvokeEvent } from "electron";
import type { IpcHandle } from "./ipc-handle";
import * as gitOps from "./git";
import { gitStatus, invalidateGitStatus } from "./git-status";
import { wireOf, wireStr } from "../src/store";
import type { RuntimeFacade } from "../src/runtime-facade";

type Handle = IpcHandle;

export function registerGitIpc(handle: Handle, deps: { getRuntime: () => RuntimeFacade }): void {
  const { getRuntime } = deps;
  handle("pideck:git-status", async (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || cwd.length > 4096) throw new Error("invalid cwd");
    try {
      return await gitStatus(cwd);
    } catch {
      return { isRepo: false, dirty: [], ahead: 0, behind: 0 };
    }
  });
  // Git integration (status, commit/push/pull, branches, pull requests)
  const requireCwd = (cwd: unknown): string => {
    if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4096) throw new Error("invalid cwd");
    return cwd;
  };
  handle("pideck:git-status-details", async (_e, cwd: unknown) => {
    try {
      return await gitOps.statusDetails(requireCwd(cwd));
    } catch {
      return { isRepo: false };
    }
  });
  handle("pideck:git-branches", (_e, cwd: unknown) => gitOps.listBranches(requireCwd(cwd)));
  handle("pideck:git-diff-file", async (_e, cwd: unknown, file: unknown) => {
    const root = requireCwd(cwd);
    if (typeof file !== "string" || file.length === 0 || file.length > 1024 || file.includes("\u0000")) {
      throw new Error("invalid file path");
    }
    return gitOps.diffForFile(root, file);
  });
  handle("pideck:git-branch-create", async (_e, cwd: unknown, name: unknown, switchTo: unknown) => {
    if (typeof name !== "string" || name.length > 200) throw new Error("invalid branch name");
    const root = requireCwd(cwd);
    const result = await gitOps.createBranch(root, name, switchTo === true);
    invalidateGitStatus(root);
    return result;
  });
  handle("pideck:git-branch-switch", async (_e, cwd: unknown, name: unknown, options: unknown) => {
    if (typeof name !== "string" || name.length > 200) throw new Error("invalid branch name");
    let switchOpts: { stash?: boolean } | undefined;
    if (options !== undefined) {
      const stash = wireOf(options)?.stash;
      if (typeof stash !== "boolean") throw new Error("invalid switch options");
      switchOpts = { stash };
    }
    const root = requireCwd(cwd);
    const result = await gitOps.switchBranch(root, name, switchOpts);
    invalidateGitStatus(root);
    return result;
  });
  handle("pideck:git-commit-push", async (event, cwd: unknown, requestId: unknown) => {
    const root = requireCwd(cwd);
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 100) throw new Error("invalid request id");
    if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) throw new Error("invalid request id format");
    type CommitPushPhase = "preparing" | "generating" | "committing" | "pushing" | "done" | "error";
    const emit = (phase: CommitPushPhase, message: string) => {
      if (!event.sender.isDestroyed()) event.sender.send("pideck:git-commit-push-progress", { requestId, phase, message });
    };
    let committed = false;
    let stagedForRecovery = false;
    let prepared: import("./git").PreparedCommitContext | null = null;
    try {
      emit("preparing", "Staging changes and preparing diff context");
      prepared = await gitOps.prepareCommitContext(root);
      const context = prepared;
      stagedForRecovery = true;
      if (context.truncatedPatch) emit("generating", "Generating commit message (patch truncated, using file summary for remaining changes)");
      else emit("generating", "Generating commit message");
      const generated = await getRuntime().generateCommitMessage(context);
      emit("committing", `Committing ${generated.subject}`);
      const commit = await gitOps.commitStaged(root, generated.message);
      committed = true;
      stagedForRecovery = false;
      emit("pushing", "Pushing current branch");
      const push = await gitOps.pushCurrentBranch(root);
      const pushLabel = push.status === "skipped_up_to_date" ? `Already up to date on ${push.branch}` : `Committed and pushed ${push.branch}`;
      emit("done", pushLabel);
      invalidateGitStatus(root);
      return { generated, commit, push };
    } catch (cause) {
      // If we staged via prepareCommitContext but failed before commit, restore
      // the user's pre-existing staged selection instead of leaving a
      // half-staged state.
      if (stagedForRecovery && !committed) {
        await gitOps.resetStaged(root, prepared ?? undefined);
        invalidateGitStatus(root);
        emit("error", `${cause instanceof Error ? cause.message : String(cause)}, staged changes were unstaged`);
      }
      const detail = cause instanceof Error ? cause.message : String(cause);
      const message = committed ? `Commit succeeded, but push failed: ${detail}` : detail;
      if (!stagedForRecovery || committed) emit("error", message);
      throw new Error(message);
    }
  });
  handle("pideck:git-commit", async (_e, cwd: unknown, message: unknown) => {
    if (typeof message !== "string" || message.length > 20_000) throw new Error("invalid commit message");
    const root = requireCwd(cwd);
    const result = await gitOps.commitAll(root, message);
    invalidateGitStatus(root);
    return result;
  });
  handle("pideck:git-push", async (_e, cwd: unknown) => {
    const root = requireCwd(cwd);
    const result = await gitOps.pushCurrentBranch(root);
    invalidateGitStatus(root);
    return result;
  });
  handle("pideck:git-pull", async (_e, cwd: unknown) => {
    const root = requireCwd(cwd);
    const result = await gitOps.pullCurrentBranch(root);
    invalidateGitStatus(root);
    return result;
  });
  handle("pideck:git-pr-context", (_e, cwd: unknown) => gitOps.prContext(requireCwd(cwd)));
  handle("pideck:git-pr-suggest", (_e, cwd: unknown) => gitOps.suggestPrContent(requireCwd(cwd)));
  handle("pideck:git-pr-create", async (_e, cwd: unknown, input: unknown) => {
    const title = wireStr(wireOf(input), "title");
    const body = wireStr(wireOf(input), "body");
    if (typeof title !== "string" || title.length > 500) throw new Error("invalid PR title");
    if (body !== undefined && body.length > 100_000) throw new Error("invalid PR body");
    const root = requireCwd(cwd);
    const result = await gitOps.createPr(root, { title, body: typeof body === "string" ? body : "" });
    invalidateGitStatus(root);
    return result;
  });
  handle("pideck:git-stage-file", async (_e, cwd: unknown, file: unknown) => {
    if (typeof file !== "string" || !file.trim() || file.length > 4096) throw new Error("invalid file");
    const root = requireCwd(cwd);
    const result = await gitOps.stageFile(root, file);
    invalidateGitStatus(root);
    return result;
  });
  handle("pideck:git-unstage-file", async (_e, cwd: unknown, file: unknown) => {
    if (typeof file !== "string" || !file.trim() || file.length > 4096) throw new Error("invalid file");
    const root = requireCwd(cwd);
    const result = await gitOps.unstageFile(root, file);
    invalidateGitStatus(root);
    return result;
  });
  handle("pideck:git-discard-file", async (_e, cwd: unknown, file: unknown) => {
    if (typeof file !== "string" || !file.trim() || file.length > 4096) throw new Error("invalid file");
    const root = requireCwd(cwd);
    const result = await gitOps.discardFile(root, file);
    invalidateGitStatus(root);
    return result;
  });
  handle("pideck:git-stage-hunk", async (_e, cwd: unknown, file: unknown, patch: unknown) => {
    if (typeof file !== "string" || !file.trim() || file.length > 4096) throw new Error("invalid file");
    if (typeof patch !== "string" || !patch.trim() || patch.length > 200_000) throw new Error("invalid patch");
    const root = requireCwd(cwd);
    const result = await gitOps.stageHunk(root, file, patch);
    invalidateGitStatus(root);
    return result;
  });
  handle("pideck:git-discard-hunk", async (_e, cwd: unknown, file: unknown, patch: unknown) => {
    if (typeof file !== "string" || !file.trim() || file.length > 4096) throw new Error("invalid file");
    if (typeof patch !== "string" || !patch.trim() || patch.length > 200_000) throw new Error("invalid patch");
    const root = requireCwd(cwd);
    const result = await gitOps.discardHunk(root, file, patch);
    invalidateGitStatus(root);
    return result;
  });
}
