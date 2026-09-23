import type { DesignStage, DesignStatus } from "../../electron/design-mode/store";

// Approval-only strip joined to the top of the composer: renders solely
// when a GUI approval is pending (brief review / brand review). Elicitation
// and build live in the composer itself — the composer's accent border
// signals design mode, so there is no steady-state chrome.
export function DesignStrip({
  status,
  onApproveBrief,
  onApproveBrand,
  onFinish,
  onClear,
}: {
  status: DesignStatus | null;
  onApproveBrief(): void;
  onApproveBrand(): void;
  onFinish(): void;
  onClear(): void;
}) {
  const design = status?.design ?? null;
  const stage: DesignStage = status?.stage ?? "idle";
  const finished = stage === "done";

  if (!design) return null;

  // Elicit is the quiet steady state; every other stage earns its word.
  const stageWord =
    !design || stage === "elicit"
      ? null
      : stage === "brief-confirm"
        ? "brief review"
        : stage === "brand"
          ? "brand review"
          : stage;

  return (
    <div className="goal-strip" aria-label={`Design: ${design.subject}`}>
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${finished ? "bg-dim" : stage === "build" ? "bg-ok" : "bg-warn"}`}
      />
      <span className="goal-objective" title={design.subject}>
        {design.subject}
      </span>
      {stageWord ? <span className="shrink-0">{stageWord}</span> : null}
      <span className="ml-auto flex shrink-0 items-center">
        {finished ? (
          <button type="button" onClick={onClear} className="thread-action thread-action-text text-[12px]">
            New design
          </button>
        ) : (
          <>
            {stage === "brief-confirm" ? (
              <button type="button" onClick={onApproveBrief} className="thread-action thread-action-text text-[12px]">
                Approve brief
              </button>
            ) : null}
            {stage === "brand" ? (
              <button type="button" onClick={onApproveBrand} className="thread-action thread-action-text text-[12px]">
                Approve brand
              </button>
            ) : null}
            <button type="button" onClick={onFinish} className="thread-action thread-action-text text-[12px]">
              Finish
            </button>
          </>
        )}
      </span>
    </div>
  );
}
