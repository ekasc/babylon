/**
 * Send = acquire project execution ownership, then execute the turn in the
 * captured session (execution/view split, src/execution.ts I4/I7/I8).
 *
 * The target/cwd are captured by the caller AT SUBMISSION and flow through
 * `input` only — navigation after submission is presentation state, never
 * execution identity. `PiHost` (via executionActivate) is the sole
 * arbiter of I1/I4: same-owner sends are a map lookup, idle owners
 * transfer, busy owners reject with a structured envelope. Nothing here
 * reads any runtime status — executionActivate IS the warmup.
 */
import type { Bridge, PromptImage } from "../bridge";
import type { ProjectExecution } from "../execution";

type ActivationResult = Awaited<ReturnType<Bridge["executionActivate"]>>;
type GroupResult = Awaited<ReturnType<Bridge["groupSend"]>>;
type GoalResult = Awaited<ReturnType<Bridge["beginGoalPrompt"]>>;
type DesignResult = Awaited<ReturnType<Bridge["beginDesignPrompt"]>>;

export type SendStage =
  | { stage: "activation-failed" }
  | { stage: "busy"; busySessionFile: string; busySessionId: string }
  | { stage: "group"; room: GroupResult }
  | { stage: "goal"; result: GoalResult }
  | { stage: "design"; result: DesignResult }
  | { stage: "prompted" };

export interface SendExecutionDeps {
  bridge: Pick<Bridge, "executionActivate" | "prompt" | "beginGoalPrompt" | "beginDesignPrompt" | "groupSend">;
  /** preparingTurn = waiting for executionActivate(). */
  setPreparingTurn(v: boolean): void;
  /** Synchronous registry merge on successful activation — the push event
   *  is only an idempotent generation-filtered echo. */
  onActivated(execution: ProjectExecution): void;
  /** Roll back the optimistic user row (caller closes over hasContent). */
  rollbackOptimistic(): void;
  /** Re-read rollback projections after a failed attempt. */
  hydrateIfRollback(): void;
  busyToast(busySessionFile: string): void;
  activationFailedToast(error: unknown): void;
  /** Room (group) id when the viewed session is a group room (null for
   *  1:1). The room session IS the viewed target — activeGroup only exists
   *  while viewing the room, so acquisition above already owned it. */
  roomGroupId: string | null;
  goalArmed: boolean;
  designArmed: boolean;
  /** Consumed exactly when the goal/design turn is actually submitted. */
  onGoalSubmit?(): void;
  onDesignSubmit?(): void;
  /**
   * Navigation identity at submission (test seam for I7/I8: mutation check
   * proves a view change mid-activation can never re-target the send).
   * Production code must never read this after input capture.
   */
  viewedPathRef?: { current: string | null };
}

export interface SendExecutionInput {
  /** Project cwd at submission. */
  cwd: string;
  /** Session file at submission — the immutable execution target. */
  target: string;
  text: string;
  /** Mapped image payloads (attachment → PromptImage). */
  images?: PromptImage[];
  streamingBehavior?: "steer" | "followUp";
}

/**
 * The whole warmup: acquire the project's execution slot for `sessionFile`.
 * Same-owner returns immediately; transfers release the idle owner; a busy
 * owner comes back as `{ ok:false, code: PROJECT_EXECUTION_BUSY, ... }`.
 */
export async function acquireSendExecution(
  bridge: Pick<Bridge, "executionActivate">,
  cwd: string,
  sessionFile: string
): Promise<ActivationResult> {
  return bridge.executionActivate(cwd, sessionFile);
}

/**
 * Ownership first, then exactly one top-level turn — for every branch
 * (room, goal, design, plain prompt). Throws only for turn-phase transport
 * failures, AFTER rolling the optimistic row back (the caller's catch
 * surfaces the error; it must not roll back a second time for the same
 * attempt... the reducer is idempotent per text, but keeping rollback here
 * makes the failure contract testable in isolation).
 */
export async function performSend(deps: SendExecutionDeps, input: SendExecutionInput): Promise<SendStage> {
  const { cwd, target } = input;
  deps.setPreparingTurn(true);
  let activation: ActivationResult;
  try {
    activation = await acquireSendExecution(deps.bridge, cwd, target);
  } catch (e) {
    deps.rollbackOptimistic();
    deps.activationFailedToast(e);
    return { stage: "activation-failed" };
  } finally {
    // preparingTurn covers execution activation only — legacy openSession
    // runtime readiness is not part of the Send contract.
    deps.setPreparingTurn(false);
  }

  if (!activation.ok) {
    // Busy owner: deliberately boring. No abort, no queue, no navigation,
    // no local ownership mutation, no retry — the backend arbitrates (I4).
    deps.rollbackOptimistic();
    deps.hydrateIfRollback();
    deps.busyToast(activation.busySessionFile);
    return { stage: "busy", busySessionFile: activation.busySessionFile, busySessionId: activation.busySessionId };
  }
  deps.onActivated(activation.execution);

  // ── TARGET IS IMMUTABLE FROM HERE (I7/I8) ──────────────────────────────
  try {
    if (deps.roomGroupId && !input.streamingBehavior) {
      // Room driver: serial member turns in the same (room) session. The
      // room session IS `target`, so acquisition above already owned it.
      const room = await deps.bridge.groupSend(deps.roomGroupId, input.text);
      return { stage: "group", room };
    }
    if (deps.goalArmed) {
      deps.onGoalSubmit?.();
      const result = await deps.bridge.beginGoalPrompt(target, input.text, input.text, input.images, input.streamingBehavior);
      return { stage: "goal", result };
    }
    if (deps.designArmed) {
      deps.onDesignSubmit?.();
      const result = await deps.bridge.beginDesignPrompt(target, input.text, input.text, input.images, input.streamingBehavior);
      return { stage: "design", result };
    }
    await deps.bridge.prompt(input.text, input.images, input.streamingBehavior, target);
    return { stage: "prompted" };
  } catch (e) {
    // Turn-phase failure AFTER ownership: the slot stays with `target`
    // (ownership is execution context, not a successful model response);
    // only the optimistic row rolls back.
    deps.rollbackOptimistic();
    deps.hydrateIfRollback();
    throw e;
  }
}
