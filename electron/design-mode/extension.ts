import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createSyntheticSourceInfo,
  type Extension,
  type ExtensionCommandContext,
  type ExtensionContext,
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
  slugFor,
  stageFor,
  type DesignState,
} from "./store";

/**
 * Babylon's hardbaked design-mode extension: the phased design flow
 * (elicitation → brief → brand approval → build → judge/revise → log)
 * as a silent GUI mode plus small chassis.
 *
 * Registered inline in pi-host's `extensionsOverride` (same pattern as the
 * goal-mode extension) so `/design` exists in every Babylon session.
 *
 * GUI contract: the composer Design button toggles the mode. No follow-up
 * user message is ever injected — the transcript stays clean and all
 * elicitation happens in normal chat via the composer. Stage behavior
 * arrives silently through `before_agent_start` system-prompt injection.
 * Approvals arrive via GUI strip buttons (Approve brief / Approve brand),
 * never via pasted `/design` commands or ask_question dialogs.
 *
 * Stage derives from artifacts, not from a manual step counter: no brief →
 * elicit, unapproved brief → confirm, unapproved brand → brand gate,
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
      artifactExists(cwd, state.brandPath)
    );
    return stageFor(
      clean,
      artifactExists(cwd, clean.briefPath),
      artifactExists(cwd, clean.brandPath)
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

    if (sub === "approve-brief") {
      const state = await loadDesignState(at.cwd, at.sessionId);
      if (!state) {
        ctx.ui.notify("No design session. Use /design start <subject> first.", "warning");
        return;
      }
      if (!artifactExists(at.cwd, state.briefPath)) {
        ctx.ui.notify("No brief to approve yet — the interview comes first.", "warning");
        return;
      }
      const approved = { ...state, briefApproved: true };
      await saveDesignState(at.cwd, at.sessionId, approved);
      await clearStatus();
      // Silent: brand stage playbook arrives via system prompt injection.
      return;
    }

    if (sub === "approve-brand") {
      const state = await loadDesignState(at.cwd, at.sessionId);
      if (!state?.briefApproved) {
        ctx.ui.notify("The brief must be approved before the brand.", "warning");
        return;
      }
      if (!artifactExists(at.cwd, state.brandPath)) {
        ctx.ui.notify("No brand direction to approve yet.", "warning");
        return;
      }
      const approved = { ...state, brandApproved: true };
      await saveDesignState(at.cwd, at.sessionId, approved);
      await clearStatus();
      // Silent: build stage playbook arrives via system prompt injection.
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

    ctx.ui.notify("Usage: /design [start <subject> | resume | status | set-target <web | mobile-web | native> | approve-brief | approve-brand | done | clear]", "warning");
  };

  const commands = new Map([
    [
      "design",
      {
        name: "design",
        sourceInfo,
        description: "Phased design flow: interview, brief, brand approval, build, visual review",
        handler: designCommand,
      },
    ],
  ]);

  return {
    path: DESIGN_INLINE_PATH,
    resolvedPath: DESIGN_INLINE_PATH,
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
