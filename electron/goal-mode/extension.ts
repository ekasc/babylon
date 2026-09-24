import {
  createSyntheticSourceInfo,
  type AgentEndEvent,
  type Extension,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createDurableGoalState,
  defaultDurableGoalModeConfig,
  durableCompletedWithMarker,
  isSessionId,
  renderDurableGoalContext,
  slugify,
  type DurableGoalModeConfig,
  type DurableGoalState,
  type DurableGoalStatus,
} from "../../src/lib/durable-goal";
import { clearSessionGoal, loadGoalModeConfig, loadSessionGoal, saveSessionGoal } from "./store";
import { loadDesignState } from "../design-mode/store";
import { goalChangedFiles } from "./git";

/**
 * Babylon's hardbaked goal-mode extension (vendored from the `goal-mode` pi
 * extension, adapted from per-project to per-session state).
 *
 * Registered inline in pi-host's `extensionsOverride` (same pattern as the
 * snapcompact extension) so `/goal` and goal tracking exist in every
 * Babylon session whether or not the user installed the external copy.
 * pi-host drops external goal-mode extensions from Babylon sessions so the
 * two can never double-inject or double-dispatch.
 *
 * State lives per session at `<cwd>/.pi/state/goal-mode/sessions/<id>.json`
 * (project-local, and already excluded from turn snapshots as bookkeeping).
 * The external copy's per-project `current.json` is left untouched.
 */

export const GOAL_INLINE_PATH = "<babylon-goal-inline>";

/**
 * True for an externally loaded goal-mode extension (the `~/.pi` copy or
 * any fork registering the `goal` command). pi-host drops these from
 * Babylon sessions so the hardbaked copy below is the only goal system:
 * two copies would double-inject the system prompt and double-dispatch
 * follow-ups. The user's CLI sessions are unaffected (this filter only
 * runs in Babylon's own services). Path matching is a fallback for
 * copies whose commands are not yet registered; the inline copy itself is
 * never matched.
 */
export function isExternalGoalModeExtension(ext: {
  path?: string;
  resolvedPath?: string;
  commands?: Map<string, unknown>;
}): boolean {
  if (ext.path === GOAL_INLINE_PATH || ext.resolvedPath === GOAL_INLINE_PATH) return false;
  if (ext.commands instanceof Map && ext.commands.has("goal")) return true;
  // Segment-wise: a trailing newline must not defeat the end anchor.
  const segments = `${ext.path ?? ""}\n${ext.resolvedPath ?? ""}`.split("\n");
  return segments.some((segment) => /(^|\/)goal-mode(\/|$)/.test(segment));
}

const MAX_GOAL_LENGTH = 4000;

export interface GoalModeExtensionDeps {
  /** Owning session's project root; null before the session is attached. */
  getCwd(): string | null;
  /** Owning pi session id; null before attach. Drives the state-file key. */
  getSessionId(): string | null;
  /** Whether the project is trusted (gates project-level behavior config). */
  isProjectTrusted(): boolean;
  /** Queue a follow-up on the owning session (auto-continue / goal start). */
  sendFollowUp(text: string): void;
}

function renderGoalStatus(state: DurableGoalState | null): string {
  if (!state) return "No goal is set.";
  return [
    `Objective: ${state.objective}`,
    `Status: ${state.status}${state.paused ? " (paused)" : ""}`,
    `Current step: ${state.currentStep}`,
    `Turns: ${state.turnCount ?? 0}`,
    "",
    "Acceptance criteria:",
    ...state.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "Non-goals:",
    ...state.nonGoals.map((nonGoal) => `- ${nonGoal}`),
    "",
    "Evidence:",
    ...(state.evidence.length ? state.evidence.map((item) => `- ${item}`) : ["(none)"]),
  ].join("\n");
}

function extractLastAssistantText(event: AgentEndEvent): string {
  const assistant = [...event.messages].reverse().find((message) => (message as { role?: string }).role === "assistant");
  if (!assistant) return "";
  const content = (assistant as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "type" in part && (part as { type?: string }).type === "text" && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : ""
    )
    .filter(Boolean)
    .join("\n");
}

function renderContinuationPrompt(): string {
  return "[Goal Mode Continue]\nContinue the active goal from the current step. Stay inside scope and verify before declaring completion.";
}

export function createGoalModeExtension(deps: GoalModeExtensionDeps): Extension {
  const sourceInfo = createSyntheticSourceInfo(GOAL_INLINE_PATH, { source: "goal", scope: "temporary", origin: "package" });
  let config: DurableGoalModeConfig | null = null;
  let currentInputSource: "interactive" | "rpc" | "extension" = "interactive";
  let currentInputText = "";

  const context = (): { cwd: string; sessionId: string } | null => {
    const cwd = deps.getCwd();
    const sessionId = deps.getSessionId();
    // A non-id session (phantom runtime, exotic test id) must never reach
    // the state-file path builder, which throws fail-closed on it.
    if (!cwd || !sessionId || !isSessionId(sessionId)) return null;
    return { cwd, sessionId };
  };

  async function loadConfig(cwd: string): Promise<DurableGoalModeConfig> {
    return loadGoalModeConfig(cwd, defaultDurableGoalModeConfig(), deps.isProjectTrusted());
  }

  function appendLog(state: DurableGoalState, event: string, details: Record<string, unknown> = {}): DurableGoalState {
    return { ...state, log: [...state.log, { at: new Date().toISOString(), event, details }] };
  }

  const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const on = (name: string, fn: (event: never, ctx: ExtensionContext) => unknown): void => {
    const list = handlers.get(name) ?? [];
    list.push(fn);
    handlers.set(name, list);
  };

  on("input", (event) => {
    const source = (event as { source?: unknown }).source;
    if (source === "interactive" || source === "rpc" || source === "extension") currentInputSource = source;
    const text = (event as { text?: unknown }).text;
    currentInputText = typeof text === "string" ? text : "";
  });

  on("before_agent_start", async (event, ctx) => {
    const at = context();
    if (!at) return;
    config = await loadConfig(at.cwd);
    const state = await loadSessionGoal(at.cwd, at.sessionId);
    if (!config.enabled || !config.behavior.injectGoalIntoSystemPrompt || !state?.active || state.paused) return;
    const prompt = renderDurableGoalContext(state, config.behavior.completionMarker ?? "GOAL_DONE");
    const systemPrompt = (event as { systemPrompt?: unknown }).systemPrompt;
    if (typeof systemPrompt !== "string") return;
    return { systemPrompt: `${systemPrompt}\n\n${prompt}` };
  });

  on("agent_end", async (event, ctx) => {
    const at = context();
    if (!at) return;
    config = await loadConfig(at.cwd);
    if (!config.enabled || !config.behavior.trackAfterEveryAgentEnd) return;
    const state = await loadSessionGoal(at.cwd, at.sessionId);
    if (!state?.active || state.paused) return;

    const files = await goalChangedFiles(at.cwd);
    const marker = config.behavior.completionMarker ?? "GOAL_DONE";
    const assistantText = extractLastAssistantText(event as unknown as AgentEndEvent);
    const turnCount = (state.turnCount ?? 0) + 1;
    const maxTurns = config.behavior.maxTurns ?? 40;

    if (durableCompletedWithMarker(assistantText, marker)) {
      await saveSessionGoal(
        at.cwd,
        at.sessionId,
        appendLog(
          { ...state, active: false, status: "complete", turnCount, doneAt: new Date().toISOString() },
          "completed_by_marker",
          { marker, changedFiles: files }
        )
      );
      if (ctx.hasUI) ctx.ui.setStatus("goal", undefined);
      return;
    }

    if (turnCount >= maxTurns) {
      await saveSessionGoal(
        at.cwd,
        at.sessionId,
        appendLog(
          { ...state, paused: true, status: "paused", turnCount, maxTurnsReached: true, pausedAt: new Date().toISOString() },
          "max_turns_reached",
          { maxTurns }
        )
      );
      if (ctx.hasUI) ctx.ui.setStatus("goal", "goal:paused-max-turns");
      return;
    }

    const lastAssistant = (event as unknown as AgentEndEvent).messages.length
      ? [...(event as unknown as AgentEndEvent).messages].reverse().find((m) => (m as { role?: string }).role === "assistant")
      : undefined;
    const failed =
      (lastAssistant as { stopReason?: string; errorMessage?: string } | undefined)?.stopReason === "error" ||
      Boolean((lastAssistant as { errorMessage?: string } | undefined)?.errorMessage);
    const nextStatus: DurableGoalStatus = failed ? "blocked" : files.length > 0 ? "verifying" : "executing";
    const next = appendLog({ ...state, status: nextStatus, turnCount }, "agent_end", {
      changedFiles: files,
      status: nextStatus,
      inputSource: currentInputSource,
    });
    await saveSessionGoal(at.cwd, at.sessionId, next);

    const goalOwnedExtensionTurn = currentInputText.startsWith("[Goal Mode");
    const mayContinue = currentInputSource !== "extension" || goalOwnedExtensionTurn;
    if (config.behavior.autoContinueUntilDone && nextStatus !== "blocked" && mayContinue) {
      deps.sendFollowUp(renderContinuationPrompt());
    }
  });

  // Same compaction guard as upstream: a threshold compaction can consume the
  // queued continuation, so re-queue it when the goal is still active and
  // nothing is already pending.
  on("session_compact", async (event, ctx) => {
    const at = context();
    if (!at) return;
    config = await loadConfig(at.cwd);
    if (!config.enabled || !config.behavior.autoContinueUntilDone) return;
    const state = await loadSessionGoal(at.cwd, at.sessionId);
    if (!state?.active || state.paused) return;
    const ev = event as { willRetry?: unknown; reason?: unknown };
    if (ev.willRetry) return;
    if (ev.reason !== "threshold") return;
    if (state.status === "blocked") return;
    if (ctx.hasPendingMessages()) return;
    const maxTurns = config.behavior.maxTurns ?? 40;
    if ((state.turnCount ?? 0) >= maxTurns) return;
    deps.sendFollowUp(renderContinuationPrompt());
  });

  on("session_start", async (_event, ctx) => {
    const at = context();
    if (!at) return;
    config = await loadConfig(at.cwd);
    const state = await loadSessionGoal(at.cwd, at.sessionId);
    if (state?.active && !state.paused && config.behavior.showStatusInTui && ctx.hasUI) {
      ctx.ui.setStatus("goal", `goal:${state.status}`);
    }
  });

  const goalCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const at = context();
    // The command mutates session state, so without an attached session
    // there is nothing to act on. This only happens for phantom runtimes.
    if (!at) {
      ctx.ui.notify("No active session for goal control", "warning");
      return;
    }
    config = await loadConfig(at.cwd);
    if (!config.enabled) {
      ctx.ui.notify("Goal Mode is disabled", "warning");
      return;
    }
    let state = await loadSessionGoal(at.cwd, at.sessionId);

    const raw = args.trim();
    const parts = raw ? raw.split(/\s+/) : [];
    const sub = parts[0] ?? "";
    const sub2 = parts[1] ?? "";
    const rest = parts.slice(2).join(" ").trim();

    // Bare /goal views the durable objective.
    if (!raw || (sub === "status" && parts.length === 1)) {
      ctx.ui.notify(renderGoalStatus(state), "info");
      return;
    }

    if (sub === "edit") {
      const objective = parts.slice(1).join(" ").trim();
      if (!state) {
        ctx.ui.notify("No goal is set. Use /goal <objective> first.", "warning");
        return;
      }
      if (!objective) {
        ctx.ui.notify("Usage: /goal edit <objective>", "warning");
        return;
      }
      if (objective.length > MAX_GOAL_LENGTH) {
        ctx.ui.notify(`Goal is too long (${objective.length}/${MAX_GOAL_LENGTH}). Put detailed instructions in a file and reference it.`, "warning");
        return;
      }
      await saveSessionGoal(
        at.cwd,
        at.sessionId,
        appendLog(
          { ...state, objective, slug: slugify(objective), active: true, paused: false, pausedAt: null, status: "executing", maxTurnsReached: false },
          "edited",
          { objective }
        )
      );
      if (ctx.hasUI) ctx.ui.setStatus("goal", "goal:executing");
      ctx.ui.notify("Goal updated", "info");
      return;
    }

    if (sub === "clear" && parts.length === 1) {
      await clearSessionGoal(at.cwd, at.sessionId);
      if (ctx.hasUI) ctx.ui.setStatus("goal", undefined);
      ctx.ui.notify("Goal cleared", "info");
      return;
    }

    if (sub === "criteria" && sub2 === "add") {
      if (!state?.active || !rest) {
        ctx.ui.notify("Usage: /goal criteria add <criterion>", "warning");
        return;
      }
      await saveSessionGoal(at.cwd, at.sessionId, appendLog({ ...state, acceptanceCriteria: [...state.acceptanceCriteria, rest] }, "criteria_added", { criterion: rest }));
      ctx.ui.notify("Criterion added", "info");
      return;
    }
    if (sub === "criteria" && sub2 === "list") {
      ctx.ui.notify((state?.acceptanceCriteria ?? []).map((criterion) => `- ${criterion}`).join("\n") || "(none)", "info");
      return;
    }
    if (sub === "non-goal" && sub2 === "add") {
      if (!state?.active || !rest) {
        ctx.ui.notify("Usage: /goal non-goal add <constraint>", "warning");
        return;
      }
      await saveSessionGoal(at.cwd, at.sessionId, appendLog({ ...state, nonGoals: [...state.nonGoals, rest] }, "non_goal_added", { constraint: rest }));
      ctx.ui.notify("Non-goal added", "info");
      return;
    }
    if (sub === "evidence" && sub2 === "add") {
      if (!state?.active || !rest) {
        ctx.ui.notify("Usage: /goal evidence add <note>", "warning");
        return;
      }
      await saveSessionGoal(at.cwd, at.sessionId, appendLog({ ...state, evidence: [...state.evidence, rest] }, "evidence_added", { note: rest }));
      ctx.ui.notify("Evidence added", "info");
      return;
    }
    if (sub === "evidence" && sub2 === "list") {
      ctx.ui.notify((state?.evidence ?? []).map((item) => `- ${item}`).join("\n") || "(none)", "info");
      return;
    }

    if (["pause", "resume", "done", "cancel"].includes(sub) && parts.length === 1) {
      if (!state) {
        ctx.ui.notify("No goal is set", "warning");
        return;
      }
      const next = { ...state };
      const now = new Date().toISOString();
      if (sub === "pause") {
        next.paused = true;
        next.status = "paused";
        next.pausedAt = now;
      }
      if (sub === "resume") {
        // Mutual exclusion: resuming pursuit while a design waits at an
        // approval gate would interleave the two execution models. Pause,
        // done, cancel, and clear stay available as the way out.
        const design = await loadDesignState(at.cwd, at.sessionId).catch(() => null);
        if (design && !design.done) {
          ctx.ui.notify("A design session is active — end it before resuming this goal.", "warning");
          return;
        }
        next.paused = false;
        next.active = true;
        next.status = "executing";
        next.maxTurnsReached = false;
        next.pausedAt = null;
        delete next.doneAt;
      }
      if (sub === "done") {
        next.active = false;
        next.status = "complete";
        next.paused = false;
        next.pausedAt = null;
        next.doneAt = now;
      }
      if (sub === "cancel") {
        next.active = false;
        next.status = "cancelled";
        next.doneAt = now;
      }
      await saveSessionGoal(at.cwd, at.sessionId, appendLog(next, sub));
      if (ctx.hasUI) ctx.ui.setStatus("goal", next.active && !next.paused ? `goal:${next.status}` : undefined);
      ctx.ui.notify(`Goal ${sub}`, "info");
      return;
    }

    if (sub === "step") {
      const step = parts.slice(1).join(" ").trim();
      if (!state?.active || !step) {
        ctx.ui.notify("Usage: /goal step <step>", "warning");
        return;
      }
      const completed = state.currentStep ? [...state.completedSteps, state.currentStep] : state.completedSteps;
      await saveSessionGoal(at.cwd, at.sessionId, appendLog({ ...state, currentStep: step, completedSteps: completed }, "step", { step }));
      ctx.ui.notify(`Step: ${step}`, "info");
      return;
    }

    const objective = raw;
    if (objective.length > MAX_GOAL_LENGTH) {
      ctx.ui.notify(`Goal is too long (${objective.length}/${MAX_GOAL_LENGTH}). Put detailed instructions in a file and reference it.`, "warning");
      return;
    }
    // Mutual exclusion: a bare objective starts autonomous pursuit, which
    // must not run under an active design's approval gates.
    const blockingDesign = await loadDesignState(at.cwd, at.sessionId).catch(() => null);
    if (blockingDesign && !blockingDesign.done) {
      ctx.ui.notify("A design session is active — end it before starting a goal.", "warning");
      return;
    }
    await saveSessionGoal(at.cwd, at.sessionId, createDurableGoalState(objective, config));
    if (ctx.hasUI) ctx.ui.setStatus("goal", "goal:planning");
    deps.sendFollowUp(
      ["[Goal Mode Start]", `Objective: ${objective}`, "Work toward the durable objective across turns. Keep changes scoped and verify the stopping condition before completion."].join("\n")
    );
  };

  const commands = new Map([
    [
      "goal",
      {
        name: "goal",
        sourceInfo,
        description: "Set, inspect, pause, resume, edit, or clear a durable goal",
        handler: goalCommand,
      },
    ],
  ]);

  return {
    path: GOAL_INLINE_PATH,
    resolvedPath: GOAL_INLINE_PATH,
    hidden: true,
    sourceInfo,
    handlers: handlers as Extension["handlers"],
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: commands as Extension["commands"],
    flags: new Map(),
    shortcuts: new Map(),
  } as Extension;
}
