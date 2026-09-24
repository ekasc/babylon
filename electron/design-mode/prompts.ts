import { JUDGE_MAX_ROUNDS, type DesignStage, type DesignState } from "./store";

/** Brief skeleton: design work starts from an interview, never a bare prompt. */
export const BRIEF_TEMPLATE = `# Brief: <subject>

## Target
<web, mobile-web, or native — plus platforms, e.g. iOS + Android>

## Scope
<what is being designed, and what is explicitly out of scope>

## Goals
<what success looks like, in order>

## Audience
<who this is for, what device/context they are on>

## Required content
<sections, copy, assets that must appear>

## Intent
<extend | evolve | rethink — and one line on what the repository already answers>

## Constraints
<tech, existing design system, accessibility, performance limits>

## Existing system to preserve
<tokens, components and patterns already in the repo that this work must not invalidate>

## Viewports
<web/mobile-web: mobile + desktop minimum, as sim preset ids, e.g. iphone + chrome-laptop. native: device models + OS versions to review on, e.g. iPhone 15 Pro (iOS 18) + Pixel 9 (Android 15)>
`;

/** Direction skeleton: the design direction, decided and signed off before any
 *  component exists.
 *
 *  Product UI work is not a brand exercise, so this covers layout, components
 *  and interaction alongside the visual language — and leads with the intent
 *  that decides how much freedom the work actually has. */
export const DIRECTION_TEMPLATE = `# Design direction: <subject>

## Intent
<extend — keep the existing design language | evolve — keep recognizable foundations, change some visual rules | rethink — new direction allowed. One line on what the repository already answers.>

## Visual language
<color, surface, elevation, iconography, illustration>

## Typography
<families, scale, roles, measure>

## Spacing & density
<spacing scale, rhythm, information density>

## Layout hierarchy
<grid, regions, what leads the eye and in what order>

## Component conventions
<buttons, inputs, cards, tables, states — and the existing components to reuse rather than reinvent>

## Interaction & motion
<feedback, transitions, what should feel instant and what should deliberate>

## Responsive behavior
<breakpoints, what reflows, what stays fixed>

## Existing system to preserve
<tokens, components, and patterns already in the repo that this work must not invalidate>

## References
<prior art, screenshots, links>
`;

export function renderDesignStatus(state: DesignState | null): string {
  if (!state) return "No design session. Use /design start <subject> to begin with an interview.";
  const flags = [
    `target: ${state.target}`,
    `brief: ${state.briefApproved ? "approved" : "pending"} (${state.briefPath})`,
    `direction: ${state.directionApproved ? "approved" : "pending"} (${state.directionPath})`,
    state.done ? "done" : "active",
  ];
  return [`Design: ${state.subject} (${state.slug})`, ...flags].join("\n");
}

/** Fallback subject for legacy states created before armed-send (which
 *  guarantees a non-empty subject and rejects empties at the backend).
 *  The agent treats it as "the user hasn't named the subject yet" — it must
 *  never appear in chat. */
export const DESIGN_UNTITLED_SUBJECT = "Untitled design";

/** Silent per-turn injection: the stage playbook for GUI mode. Elicitation
 *  happens in plain chat via the composer — never via ask_question dialogs,
 *  never via pasted /design commands. Starting is silent (the user's own
 *  message opens the turn); stage advances after approvals arrive as
 *  internal follow-up turns. Approvals arrive through the composer's
 *  Approve button. */
export function renderDesignSystemPrompt(state: DesignState, stage: DesignStage): string {
  const named = state.subject !== DESIGN_UNTITLED_SUBJECT;
  const base = named
    ? `[Design mode: ${state.subject}] Stage: ${stage}. Brief: ${state.briefPath}. Design direction: ${state.directionPath}. Log: ${state.logPath}.`
    : `[Design mode] Stage: ${stage}. Brief: ${state.briefPath}. Design direction: ${state.directionPath}. Log: ${state.logPath}. The user has not named the subject yet — their first message defines it. Never say, write, or echo "untitled".`;
  switch (stage) {
    case "elicit":
      return `${base} Establish the brief by reading the repository first, then asking only what the code and the request cannot answer.

- Investigate before interrogating: the request plus the repo usually settle target, scope, audience, platform and the existing visual system. Read it.
- Infer from the repository and state your reading in one line, so the user can correct it cheaply.
- Ask only for genuine decisions, at most TWO blocking questions in the whole interview, one at a time, in plain chat. Never ask what you just read.
- Choose the intent: EXTEND (keep the existing design language), EVOLVE (keep recognizable foundations, change some visual rules), or RETHINK (a new direction is allowed). For EXTEND and EVOLVE, derive the direction from what exists rather than inventing a palette.
- Do not use ask_question dialogs. Do not paste /design commands or template skeletons into chat.
- Record the target with the design_set_target tool call, then write the brief file and summarize it briefly in chat. Do not build anything yet.`;
    case "brief-confirm":
      return `${base} The brief exists and awaits the user's approval (composer Approve brief button). Summarize it briefly in plain chat, answer questions, revise the file on request. Do not build yet. Never ask the user to type /design commands.`;
    case "direction":
      return `${base} Propose the design direction in plain chat, write ${state.directionPath}, and summarize the proposal briefly. Read the repository first: when the design system already answers, derive the direction from it and say so instead of inventing a new palette. The user approves via the composer Approve direction button. Do not use ask_question dialogs. Do not implement anything until the direction is approved.`;
    case "build":
      return `${base} Brief + direction are approved. Call design_set_phase with "implementing" when a build turn starts, and with "needs-user" if the work cannot continue without them (judge inconclusive, native screenshots missing). A design_review verdict sets the phase itself. Implement on a branch/worktree (file writes are permission-governed), then judge: ${state.target === "native" ? "attached simulator screenshots against brief + direction" : "browser_capture_review against brief + direction"}. Pass/fail with a punchlist in plain chat, at most ${JUDGE_MAX_ROUNDS} revise rounds, then escalate in plain chat with captures and punchlist attached. Log every round to ${state.logPath}. Never use ask_question dialogs or /design commands in chat.`;
    case "done":
      return `${base} Finished. Answer follow-up questions only.`;
    case "idle":
      return base;
  }
}

/** Judge loop for URL-served targets: the agent captures the page itself. */
function webBuildBody(state: DesignState): string {
  return [
    "Implement the approved brief + design direction.",
    "- Work on a branch/worktree, never straight onto the user's checkout unless asked.",
    "- File writes are permission-governed; real failures belong in the attention inbox.",
    "- Interruptible and resumable: state lives in the artifacts, so stopping and resuming loses nothing.",
    `When a build turn lands, judge it: browser_capture_review (viewports from the brief) against brief + direction. Verdicts are thread-visible, never silent: pass/fail with a concrete punchlist.`,
    `Fail feeds one targeted build turn + re-capture. Budget: ${JUDGE_MAX_ROUNDS} rounds, then escalate to the user in plain chat with captures and punchlist attached. Escalation is a designed outcome, not a failure.`,
    `Log every round (captures, verdict, punchlist) to the log path, newest entries on top.`,
    "Failure modes: no server detected (capture errors honestly — fix the serve command, don't fake a bundle), guest crash (browser_navigate to recover), judge inconclusive (escalate).",
  ].join("\n");
}

/** Judge loop for native targets: there is no URL to capture, so review
 *  runs on simulator screenshots attached to the conversation. */
function nativeBuildBody(state: DesignState): string {
  return [
    "Implement the approved brief + design direction in the native project.",
    "- Work on a branch/worktree, never straight onto the user's checkout unless asked.",
    "- File writes are permission-governed; real failures belong in the attention inbox.",
    "- Interruptible and resumable: state lives in the artifacts, so stopping and resuming loses nothing.",
    `When a build turn lands, judge it from attached simulator screenshots (device models from the brief) against brief + direction. No screenshots attached yet: ask the user in plain chat to attach them and judge nothing until they arrive — never fake a verdict.`,
    `Verdicts are thread-visible, never silent: pass/fail with a concrete punchlist. Fail feeds one targeted build turn + fresh screenshots. Budget: ${JUDGE_MAX_ROUNDS} rounds, then escalate to the user in plain chat with the latest screenshots and punchlist attached. Escalation is a designed outcome, not a failure.`,
    `Log every round (which screenshots, verdict, punchlist) to the log path, newest entries on top.`,
    "Failure modes: no screenshots provided (ask, don't guess), build doesn't compile on the target (fix the build, don't judge a stale screen), judge inconclusive (escalate).",
  ].join("\n");
}

/** Deprecated: retained for compat/tests only. The GUI mode never injects
 *  this into chat — behavior arrives silently via renderDesignSystemPrompt. */
export function renderStageFollowUp(state: DesignState, stage: DesignStage): string {
  const head = `[Design Mode: ${stage}]\nSubject: ${state.subject}\nBrief: ${state.briefPath}\nDesign direction: ${state.directionPath}\nLog: ${state.logPath}\n`;
  switch (stage) {
    case "elicit":
      return (
        head +
        [
          "Read the repository before asking anything. A request plus an existing codebase usually answers target, scope, audience, platform and the current visual system.",
          "Then interview the user in plain chat — only for decisions the code and the request cannot answer, at most TWO blocking questions, one at a time:",
          "1. the intent: EXTEND (keep the existing design language), EVOLVE (keep recognizable foundations, change some visual rules), or RETHINK (new direction allowed)",
          "2. whatever is still genuinely undecided (usually scope boundaries, or the review surface: web viewports as sim preset ids, mobile + desktop minimum; native device models + OS versions)",
          "State what you inferred from the repository in one line so it can be corrected cheaply. Never ask what you just read.",
          "Then record the target and write the brief to the brief path using this skeleton:",
          BRIEF_TEMPLATE,
          "Present a short summary and wait for GUI approval. Never paste /design commands into chat.",
        ].join("\n")
      );
    case "brief-confirm":
      return (
        head +
        `The brief at ${state.briefPath} awaits GUI confirmation. Summarize it briefly, answer questions, revise on request. Advance only on GUI approval.`
      );
    case "direction":
      return (
        head +
        [
          `Propose the design direction and write it to ${state.directionPath} using this skeleton:`,
          DIRECTION_TEMPLATE,
          "Derive what the repository already answers (existing tokens, components, patterns) before inventing anything new, and record the intent accordingly.",
          "Cover the brief's target: platform conventions, touch targets, and safe areas for mobile-web/native; viewport behavior for web.",
          "Then summarize it briefly in plain chat. The user approves via the composer Approve direction button.",
          "- Revise on request, present again.",
          "Do not implement anything until the direction is approved.",
          "Never paste /design commands or ask_question dialogs into chat.",
        ].join("\n")
      );
    case "build":
      return (
        head +
        (state.target === "native" ? nativeBuildBody(state) : webBuildBody(state))
      );
    case "done":
      return head + "This design session is finished. Answer follow-up questions only.";
    case "idle":
      return head + "No active design session.";
  }
}
