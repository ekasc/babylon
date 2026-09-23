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

## Constraints
<tech, brand, accessibility, performance limits>

## Viewports
<web/mobile-web: mobile + desktop minimum, as sim preset ids, e.g. iphone + chrome-laptop. native: device models + OS versions to review on, e.g. iPhone 15 Pro (iOS 18) + Pixel 9 (Android 15)>
`;

/** Brand skeleton: the visual system, decided and signed off before any
 *  component exists. */
export const BRAND_TEMPLATE = `# Brand direction: <subject>

## Tokens
<color, spacing, radius, shadow values>

## Type
<families, scale, roles>

## Rhythm
<layout grid, density, motion feel>

## References
<palette, reference images, prior art>
`;

export function renderDesignStatus(state: DesignState | null): string {
  if (!state) return "No design session. Use /design start <subject> to begin with an interview.";
  const flags = [
    `target: ${state.target}`,
    `brief: ${state.briefApproved ? "approved" : "pending"} (${state.briefPath})`,
    `brand: ${state.brandApproved ? "approved" : "pending"} (${state.brandPath})`,
    state.done ? "done" : "active",
  ];
  return [`Design: ${state.subject} (${state.slug})`, ...flags].join("\n");
}

/** Fallback subject when the mode is toggled on with an empty composer
 *  (must match the App toggle fallback). The agent treats it as "the user
 *  hasn't named the subject yet" — it must never appear in chat. */
export const DESIGN_UNTITLED_SUBJECT = "Untitled design";

/** Silent per-turn injection: the stage playbook for GUI mode. Elicitation
 *  happens in plain chat via the composer — never via ask_question dialogs,
 *  never via pasted /design commands, never via injected follow-up blocks.
 *  Approvals arrive through the composer's Approve button. */
export function renderDesignSystemPrompt(state: DesignState, stage: DesignStage): string {
  const named = state.subject !== DESIGN_UNTITLED_SUBJECT;
  const base = named
    ? `[Design mode: ${state.subject}] Stage: ${stage}. Brief: ${state.briefPath}. Brand: ${state.brandPath}. Log: ${state.logPath}.`
    : `[Design mode] Stage: ${stage}. Brief: ${state.briefPath}. Brand: ${state.brandPath}. Log: ${state.logPath}. The user has not named the subject yet — their first message defines it. Never say, write, or echo "untitled".`;
  switch (stage) {
    case "elicit":
      return `${base} Interview the user in plain chat, one question at a time (target first: web, mobile-web, or native). Do not use ask_question dialogs. Do not paste /design commands or template skeletons into chat. Record the target via the state tool call, then write the brief file and summarize it briefly in chat. Do not build anything yet.`;
    case "brief-confirm":
      return `${base} The brief exists and awaits the user's approval (composer Approve brief button). Summarize it briefly in plain chat, answer questions, revise the file on request. Do not build yet. Never ask the user to type /design commands.`;
    case "brand":
      return `${base} Propose the brand direction in plain chat, write ${state.brandPath}, and summarize the proposal briefly. The user approves via the composer Approve brand button. Do not use ask_question dialogs. Do not implement anything until the brand is approved.`;
    case "build":
      return `${base} Brief + brand are approved. Implement on a branch/worktree (file writes are permission-governed), then judge: ${state.target === "native" ? "attached simulator screenshots against brief + brand" : "browser_capture_review against brief + brand"}. Pass/fail with a punchlist in plain chat, at most ${JUDGE_MAX_ROUNDS} revise rounds, then escalate in plain chat with captures and punchlist attached. Log every round to ${state.logPath}. Never use ask_question dialogs or /design commands in chat.`;
    case "done":
      return `${base} Finished. Answer follow-up questions only.`;
    case "idle":
      return base;
  }
}

/** Judge loop for URL-served targets: the agent captures the page itself. */
function webBuildBody(state: DesignState): string {
  return [
    "Implement the approved brief + brand.",
    "- Work on a branch/worktree, never straight onto the user's checkout unless asked.",
    "- File writes are permission-governed; real failures belong in the attention inbox.",
    "- Interruptible and resumable: state lives in the artifacts, so stopping and resuming loses nothing.",
    `When a build turn lands, judge it: browser_capture_review (viewports from the brief) against brief + brand. Verdicts are thread-visible, never silent: pass/fail with a concrete punchlist.`,
    `Fail feeds one targeted build turn + re-capture. Budget: ${JUDGE_MAX_ROUNDS} rounds, then escalate to the user in plain chat with captures and punchlist attached. Escalation is a designed outcome, not a failure.`,
    `Log every round (captures, verdict, punchlist) to the log path, newest entries on top.`,
    "Failure modes: no server detected (capture errors honestly — fix the serve command, don't fake a bundle), guest crash (browser_navigate to recover), judge inconclusive (escalate).",
  ].join("\n");
}

/** Judge loop for native targets: there is no URL to capture, so review
 *  runs on simulator screenshots attached to the conversation. */
function nativeBuildBody(state: DesignState): string {
  return [
    "Implement the approved brief + brand in the native project.",
    "- Work on a branch/worktree, never straight onto the user's checkout unless asked.",
    "- File writes are permission-governed; real failures belong in the attention inbox.",
    "- Interruptible and resumable: state lives in the artifacts, so stopping and resuming loses nothing.",
    `When a build turn lands, judge it from attached simulator screenshots (device models from the brief) against brief + brand. No screenshots attached yet: ask the user in plain chat to attach them and judge nothing until they arrive — never fake a verdict.`,
    `Verdicts are thread-visible, never silent: pass/fail with a concrete punchlist. Fail feeds one targeted build turn + fresh screenshots. Budget: ${JUDGE_MAX_ROUNDS} rounds, then escalate to the user in plain chat with the latest screenshots and punchlist attached. Escalation is a designed outcome, not a failure.`,
    `Log every round (which screenshots, verdict, punchlist) to the log path, newest entries on top.`,
    "Failure modes: no screenshots provided (ask, don't guess), build doesn't compile on the target (fix the build, don't judge a stale screen), judge inconclusive (escalate).",
  ].join("\n");
}

/** Deprecated: retained for compat/tests only. The GUI mode never injects
 *  this into chat — behavior arrives silently via renderDesignSystemPrompt. */
export function renderStageFollowUp(state: DesignState, stage: DesignStage): string {
  const head = `[Design Mode: ${stage}]\nSubject: ${state.subject}\nBrief: ${state.briefPath}\nBrand: ${state.brandPath}\nLog: ${state.logPath}\n`;
  switch (stage) {
    case "elicit":
      return (
        head +
        [
          "Interview the user in plain chat before writing anything (one question at a time):",
          "1. target (web, mobile-web, or native app — and which platforms)",
          "2. subject + scope (what screen/flow, what is out of scope)",
          "3. goals (what success looks like, in order)",
          "4. audience (who, what device/context)",
          "5. required content (sections, copy, assets that must appear)",
          "6. constraints (tech, brand, a11y, performance)",
          "7. review surface (web/mobile-web: viewports as sim preset ids, mobile + desktop minimum. native: device models + OS versions to review on)",
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
    case "brand":
      return (
        head +
        [
          `Propose the visual system and write it to ${state.brandPath} using this skeleton:`,
          BRAND_TEMPLATE,
          "Cover the brief's target: platform conventions, touch targets, and safe areas for mobile-web/native; viewport behavior for web.",
          "Then summarize it briefly in plain chat. The user approves via the composer Approve brand button.",
          "- Revise on request, present again.",
          "Do not implement anything until the brand is approved.",
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
