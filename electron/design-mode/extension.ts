import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import {
  createSyntheticSourceInfo,
  type AgentToolResult,
  type Extension,
  type ExtensionCommandContext,
  type ExtensionContext,
  type RegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { isSessionId } from "../../src/lib/durable-goal";
import {
  renderDesignStatus,
  renderDesignSystemPrompt,
} from "./prompts";
import {
  clearDesignState,
  createDesignState,
  loadDesignState,
  parseDesignTarget,
  sanitizedStateFor,
  saveDesignState,
  JUDGE_MAX_ROUNDS,
  slugFor,
  stageFor,
  type DesignState,
  type DesignTarget,
} from "./store";
import { loadSessionGoal } from "../goal-mode/store";
import {
  latestReview,
  nextReviewRound,
  persistReviewShots,
  recordDesignReview,
  reviewSummary,
  type DesignReviewRecord,
  type DesignReviewShot,
} from "./review";
import {
  parseReviewSelector,
  parseReviewViewports,
  requireUrl,
} from "../sim-tool-helpers";
import type { ReviewBundle } from "../sim-controller";

/**
 * Babylon's hardbaked design-mode extension: the phased design flow
 * (elicitation → brief → direction approval → build → judge/revise → log)
 * as a silent GUI mode plus small chassis.
 *
 * Registered inline in pi-host's `extensionsOverride` (same pattern as the
 * goal-mode extension) so `/design` exists in every Babylon session.
 *
 * GUI contract: the composer Design button arms the mode; the next send
 * persists the submitted message as the subject and starts the interview
 * turn itself — no snapshot-at-click, no synthetic kickoff message. Stage
 * behavior arrives silently through `before_agent_start` system-prompt
 * injection. Approvals arrive via composer buttons (Approve brief / Approve
 * direction) and each one dispatches an internal follow-up turn for the next
 * stage (deliverAs followUp — never a synthetic user message, never pasted
 * `/design` commands or ask_question dialogs).
 *
 * Stage derives from artifacts, not from a manual step counter: no brief →
 * elicit, unapproved brief → confirm, unapproved direction → direction gate,
 * both approved → build/judge. Re-running /design therefore resumes from
 * the current artifacts by construction.
 */

export const DESIGN_INLINE_PATH = "<babylon-design-inline>";

const MAX_SUBJECT_LENGTH = 4000;

export interface DesignModeExtensionDeps {
  getCwd(): string | null;
  getSessionId(): string | null;
  /** Kept for interface parity with goal-mode; design mode no longer injects
   *  follow-up chat text (GUI mode stays silent, see above). */
  sendFollowUp(_text: string): void;
  /** Review capture for URL targets. One call is one review round, so the
   *  capture and the verdict are recorded together and the screenshots the
   *  verdict refers to are the ones on disk. */
  captureReview?: (opts: {
    url: string;
    viewports: ReturnType<typeof parseReviewViewports>;
    readySelector?: string;
    fullPage?: boolean;
  }) => Promise<ReviewBundle>;
}

/** Capture the round's screenshots and persist them beside the record. The
 *  capture is required for URL targets: a verdict that references a picture
 *  nobody can look at is not reviewable. */
async function captureReviewRound(
  deps: DesignModeExtensionDeps,
  params: { url?: unknown; viewports?: unknown; readySelector?: unknown; fullPage?: unknown },
  target: DesignTarget,
  cwd: string,
  slug: string,
  round: number
): Promise<DesignReviewShot[]> {
  if (!deps.captureReview) {
    throw new Error("Review capture is unavailable in this runtime; escalate in plain chat.");
  }
  // requireUrl validates the args object (the shape every sim tool passes).
  const url = requireUrl({ url: params.url }, "design_review");
  const bundle = await deps.captureReview({
    url,
    viewports: parseReviewViewports(params.viewports),
    ...(parseReviewSelector(params.readySelector) ? { readySelector: parseReviewSelector(params.readySelector)! } : {}),
    ...(params.fullPage === true ? { fullPage: true } : {}),
  });
  void target;
  return persistReviewShots(cwd, slug, round, bundle);
}

/** The model sees the same screenshots the record references. */
async function readReviewShotBase64(cwd: string, relPath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return (await readFile(join(cwd, relPath))).toString("base64");
}

function artifactExists(cwd: string, relPath: string): boolean {
  try {
    return existsSync(join(cwd, relPath));
  } catch {
    return false;
  }
}

export function createDesignModeExtension(deps: DesignModeExtensionDeps): Extension {
  const sourceInfo = createSyntheticSourceInfo(DESIGN_INLINE_PATH, {
    source: "design",
    scope: "temporary",
    origin: "package",
  });

  const context = (): { cwd: string; sessionId: string } | null => {
    const cwd = deps.getCwd();
    const sessionId = deps.getSessionId();
    if (!cwd || !sessionId || !isSessionId(sessionId)) return null;
    return { cwd, sessionId };
  };

  async function stageOf(
    cwd: string,
    state: DesignState | null
  ): Promise<ReturnType<typeof stageFor>> {
    if (!state) return "idle";
    // Derive from the sanitized view: a deleted artifact lapses its approval,
    // so a rewritten brief always returns to confirmation.
    const clean = sanitizedStateFor(
      state,
      artifactExists(cwd, state.briefPath),
      artifactExists(cwd, state.directionPath)
    );
    return stageFor(
      clean,
      artifactExists(cwd, clean.briefPath),
      artifactExists(cwd, clean.directionPath)
    );
  }

  const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const on = (name: string, fn: (event: never, ctx: ExtensionContext) => unknown): void => {
    const list = handlers.get(name) ?? [];
    list.push(fn);
    handlers.set(name, list);
  };

  on("before_agent_start", async (event) => {
    const at = context();
    if (!at) return;
    const state = await loadDesignState(at.cwd, at.sessionId);
    if (!state || state.done) return;
    const stage = await stageOf(at.cwd, state);
    const systemPrompt = (event as { systemPrompt?: unknown }).systemPrompt;
    if (typeof systemPrompt !== "string") return;
    return { systemPrompt: `${systemPrompt}\n\n${renderDesignSystemPrompt(state, stage)}` };
  });

  on("session_start", async (_event, ctx) => {
    const at = context();
    if (!at || !ctx.hasUI) return;
    const state = await loadDesignState(at.cwd, at.sessionId);
    if (state && !state.done) ctx.ui.setStatus("design", `design:${await stageOf(at.cwd, state)}`);
  });

  const designCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const at = context();
    if (!at) {
      ctx.ui.notify("No active session for design control", "warning");
      return;
    }
    const clearStatus = async (): Promise<void> => {
      if (ctx.hasUI) {
        const state = await loadDesignState(at.cwd, at.sessionId);
        ctx.ui.setStatus("design", state && !state.done ? `design:${await stageOf(at.cwd, state)}` : undefined);
      }
    };

    const raw = args.trim();
    const parts = raw ? raw.split(/\s+/) : [];
    const sub = parts[0] ?? "";

    // Bare /design (or /design status): report, don't start a turn.
    if (!raw || sub === "status") {
      const state = await loadDesignState(at.cwd, at.sessionId);
      ctx.ui.notify(renderDesignStatus(state), "info");
      return;
    }

    if (sub === "start" || sub === "resume") {
      // Mutual exclusion: (re)entering design pursuit while a goal is
      // active would interleave approval gates with autonomous
      // continuation. Stop/cancel the goal first; done/clear on either
      // side always stay available.
      const blockingGoal = await loadSessionGoal(at.cwd, at.sessionId).catch(() => null);
      if (blockingGoal?.active) {
        ctx.ui.notify("A goal is active — stop it before starting or resuming a design.", "warning");
        return;
      }
      let state = await loadDesignState(at.cwd, at.sessionId);
      if (!state) {
        const subject = sub === "start" ? parts.slice(1).join(" ").trim() : "";
        if (!subject) {
          ctx.ui.notify("Usage: /design start <subject>", "warning");
          return;
        }
        if (subject.length > MAX_SUBJECT_LENGTH) {
          ctx.ui.notify(`Subject is too long (${subject.length}/${MAX_SUBJECT_LENGTH}).`, "warning");
          return;
        }
        state = createDesignState(subject, slugFor(subject));
        await saveDesignState(at.cwd, at.sessionId, state);
      } else if (sub === "start") {
        const requested = parts.slice(1).join(" ").trim();
        if (requested && requested !== state.subject) {
          ctx.ui.notify(`Already designing "${state.subject}" — /design clear to switch subjects.`, "warning");
        }
      }
      await clearStatus();
      // Silent GUI mode: no follow-up chat injection. The stage playbook
      // reaches the agent via before_agent_start; the user just sees the
      // Design strip toggle on.
      return;
    }

    if (sub === "set-target") {
      const state = await loadDesignState(at.cwd, at.sessionId);
      if (!state) {
        ctx.ui.notify("No design session. Use /design start <subject> first.", "warning");
        return;
      }
      const target = parseDesignTarget(parts[1]);
      if (!target) {
        ctx.ui.notify("Usage: /design set-target <web | mobile-web | native>", "warning");
        return;
      }
      await saveDesignState(at.cwd, at.sessionId, { ...state, target });
      if (ctx.hasUI) ctx.ui.setStatus("design", state.done ? undefined : `design:${await stageOf(at.cwd, { ...state, target })}`);
      ctx.ui.notify(`Design target: ${target}`, "info");
      return;
    }

    if (sub === "done") {
      const state = await loadDesignState(at.cwd, at.sessionId);
      if (!state) {
        ctx.ui.notify("No design session.", "warning");
        return;
      }
      await saveDesignState(at.cwd, at.sessionId, { ...state, done: true });
      if (ctx.hasUI) ctx.ui.setStatus("design", undefined);
      ctx.ui.notify("Design session finished", "info");
      return;
    }

    if (sub === "clear") {
      await clearDesignState(at.cwd, at.sessionId);
      if (ctx.hasUI) ctx.ui.setStatus("design", undefined);
      ctx.ui.notify("Design session cleared", "info");
      return;
    }

    ctx.ui.notify("Usage: /design [start <subject> | resume | status | set-target <web | mobile-web | native> | done | clear]. Approvals happen from the composer's review surface.", "warning");
  };

  const commands = new Map([
    [
      "design",
      {
        name: "design",
        sourceInfo,
        description: "Phased design flow: interview, brief, design direction, build, visual review",
        handler: designCommand,
      },
    ],
  ]);

  // Model-facing target setter. The interview playbook tells the model to
  // record web | mobile-web | native, and the model must never paste
  // `/design` commands into chat — so the target needs a real tool call,
  // not just the `set-target` subcommand (which stays for CLI/manual use).
  const targetParams = Type.Object({
    target: Type.Union([Type.Literal("web"), Type.Literal("mobile-web"), Type.Literal("native")], {
      description: "App target for the design review path",
    }),
  });
  // One tool call is one review round: capture, judge, record, surface. The
  // verdict is structured (not prose in chat) so the transcript can show the
  // screenshots and the punchlist together, and so the round budget is
  // enforced by the tool instead of trusted to the model.
  const phaseParams = Type.Object({
    phase: Type.Union(
      [Type.Literal("implementing"), Type.Literal("revising"), Type.Literal("needs-user")],
      { description: "What the build loop is doing right now." }
    ),
  });

  const reviewParams = Type.Object({
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")], {
      description: "Does the current build satisfy the brief and direction?",
    }),
    punchlist: Type.Array(Type.String(), {
      description: "Concrete fixes still required, most important first. Empty when passing.",
    }),
    note: Type.Optional(
      Type.String({ description: "One or two sentences on what the screenshots show." })
    ),
    url: Type.Optional(
      Type.String({ description: "URL to capture. Required for web and mobile-web targets." })
    ),
    viewports: Type.Optional(
      Type.Array(Type.Object({ preset: Type.String(), rotated: Type.Optional(Type.Boolean()) }), {
        description: "Viewports to capture. Defaults to mobile + desktop.",
      })
    ),
    readySelector: Type.Optional(
      Type.String({ description: "Selector to wait for before capturing each viewport." })
    ),
    fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page." })),
  });

  const tools = new Map<string, RegisteredTool>([
    [
      "design_set_phase",
      {
        definition: {
          name: "design_set_phase",
          label: "Set design phase",
          description:
            "Report what the build loop is doing right now. Call 'implementing' when a build turn starts, and 'needs-user' when the work cannot continue without the user (judge inconclusive, native screenshots missing, or the round budget spent). A failing review sets 'revising' itself, so never set that by hand. Never report a round number: the reviews on disk are the only authority for that.",
          parameters: phaseParams,
          execute: async (_toolCallId: string, params: Static<typeof phaseParams>): Promise<AgentToolResult<unknown>> => {
            const at = context();
            if (!at) throw new Error("No active session for design control.");
            const state = await loadDesignState(at.cwd, at.sessionId);
            if (!state) throw new Error("No design session. Start one before reporting a phase.");
            if (state.done) throw new Error("This design session is finished.");
            const phase = (params as { phase?: unknown }).phase;
            if (phase !== "implementing" && phase !== "revising" && phase !== "needs-user") {
              throw new Error("Unknown phase.");
            }
            await saveDesignState(at.cwd, at.sessionId, { ...state, phase });
            return { content: [{ type: "text", text: `Design phase: ${phase}.` }], details: { phase } };
          },
        },
        sourceInfo,
      },
    ],
    [
      "design_review",
      {
        definition: {
          name: "design_review",
          label: "Design review",
          description:
            "Review the current build against the approved brief and direction, and record the round. Call once per round, after the build turn lands. For web/mobile-web this captures the page and attaches the screenshots to the verdict; for native, judge the screenshots already attached to the conversation. The review surface in the transcript shows the shots and the punchlist together. Never fake a verdict, and never call this after the round budget is spent — escalate in plain chat instead.",
          parameters: reviewParams,
          execute: async (_toolCallId: string, params: Static<typeof reviewParams>): Promise<AgentToolResult<unknown>> => {
            const at = context();
            if (!at) throw new Error("No active session for design control.");
            const state = await loadDesignState(at.cwd, at.sessionId);
            if (!state) throw new Error("No design session. Start one before reviewing.");
            if (state.done) throw new Error("This design session is finished.");
            if (!state.briefApproved || !state.directionApproved) {
              throw new Error("The brief and design direction must be approved before reviewing.");
            }

            const round = await nextReviewRound(at.cwd, state.slug);
            if (round > JUDGE_MAX_ROUNDS) {
              // The budget is a designed outcome, not a failure: stop judging
              // and hand the punchlist to the user.
              throw new Error(
                `Review budget spent (${JUDGE_MAX_ROUNDS} rounds recorded). Escalate in plain chat with the latest screenshots and punchlist.`
              );
            }

            const punchlist = (params.punchlist ?? []).map((p) => String(p).trim()).filter(Boolean).slice(0, 20);
            if (params.verdict === "pass" && punchlist.length > 0) {
              throw new Error("A passing review must not carry a punchlist. Either pass, or fail with the fixes.");
            }

            const shots =
              state.target === "native"
                ? []
                : await captureReviewRound(deps, params, state.target, at.cwd, state.slug, round);

            const record: DesignReviewRecord = await recordDesignReview({
              cwd: at.cwd,
              state,
              round,
              verdict: params.verdict,
              punchlist,
              ...(params.note ? { note: String(params.note) } : {}),
              shots,
            });

            // The phase follows from the verdict, never from a guess: a fail
            // means another build turn is coming, and spending the budget means
            // the user is needed.
            await saveDesignState(at.cwd, at.sessionId, {
              ...state,
              ...(record.escalated
                ? { phase: "needs-user" as const }
                : record.verdict === "fail"
                  ? { phase: "revising" as const }
                  : { phase: undefined }),
            });

            // The model judges the same pixels the transcript will show.
            const images = await Promise.all(
              shots.map(async (shot) => ({
                type: "image" as const,
                data: await readReviewShotBase64(at.cwd, shot.path),
                mimeType: "image/png" as const,
              }))
            );
            return {
              content: [{ type: "text", text: reviewSummary(record) }, ...images],
              details: record,
            };
          },
        },
        sourceInfo,
      },
    ],
    [
      "design_set_target",
      {
        definition: {
          name: "design_set_target",
          label: "Set design target",
          description:
            "Record the design session's app target (web, mobile-web, or native). Call once during the interview, before writing the brief.",
          parameters: targetParams,
          execute: async (_toolCallId: string, params: Static<typeof targetParams>): Promise<AgentToolResult<unknown>> => {
            const at = context();
            if (!at) throw new Error("No active session for design control.");
            const state = await loadDesignState(at.cwd, at.sessionId);
            if (!state) {
              throw new Error("No design session. Start one before recording a target.");
            }
            const target = parseDesignTarget((params as { target?: unknown }).target);
            if (!target) {
              throw new Error("Unknown target. Use web, mobile-web, or native.");
            }
            await saveDesignState(at.cwd, at.sessionId, { ...state, target });
            return { content: [{ type: "text", text: `Design target recorded: ${target}.` }], details: { target } };
          },
        },
        sourceInfo,
      },
    ],
  ]);

  return {
    path: DESIGN_INLINE_PATH,
    resolvedPath: DESIGN_INLINE_PATH,
    hidden: true,
    sourceInfo,
    handlers: handlers as Extension["handlers"],
    tools,
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: commands as Extension["commands"],
    flags: new Map(),
    shortcuts: new Map(),
  } as Extension;
}
