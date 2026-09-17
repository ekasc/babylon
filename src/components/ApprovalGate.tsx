import { useEffect, useRef, useState } from "react";
import { bridge, type ApprovalChoice, type ApprovalRequest } from "../bridge";

/**
 * Renders pending permission approvals raised by the Babylon permission engine
 * when an agent action needs interactive consent (supervised mode, or high /
 * uncertain risk under auto mode). Each card maps to one blocked tool call the
 * agent is waiting on; resolving it unblocks that call.
 *
 * Cards are non-modal popovers docked above the composer: they never scrim the
 * screen, so the transcript stays readable while the agent waits.
 */
export function ApprovalGate() {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);

  useEffect(() => {
    const offRequest = bridge.onApprovalRequested((req) => {
      setRequests((prev) => [...prev, req]);
    });
    // Released without a decision (e.g. Full Access was enabled while the
    // agent waited) — the gate must not keep showing a stale ask.
    const offCleared = bridge.onApprovalCleared(({ id }) => {
      setRequests((prev) => prev.filter((r) => r.id !== id));
    });
    return () => {
      offRequest();
      offCleared();
    };
  }, []);

  const resolve = async (id: string, choice: ApprovalChoice) => {
    const result = await bridge.permissionsResolveApproval(id, choice);
    if (!result.ok) throw new Error("The approval was not accepted. Please try again.");
    setRequests((prev) => prev.filter((r) => r.id !== id));
  };

  if (requests.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-40 flex flex-col items-center gap-2 px-6"
      style={{ bottom: "var(--dock-bottom, 188px)" }}
    >
      {requests.map((req) => (
        <ApprovalCard key={req.id} req={req} onResolve={resolve} />
      ))}
    </div>
  );
}

function ApprovalCard({
  req,
  onResolve,
}: {
  req: ApprovalRequest;
  onResolve(id: string, choice: ApprovalChoice): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const respond = async (choice: ApprovalChoice) => {
    setPending(true);
    setError(null);
    try {
      await onResolve(req.id, choice);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not send your decision. Please try again.");
    } finally {
      setPending(false);
    }
  };
  // Focus lands on the first action for keyboard flow, but nothing is trapped:
  // the gate is a popover, not a modal. There is deliberately no Escape
  // dismiss — denying is an explicit choice, never a keyboard accident.
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => {
      cardRef.current?.querySelector<HTMLElement>("button")?.focus();
    });
    return () => previousFocus?.focus();
  }, []);

  const riskClass =
    req.risk === "high"
      ? "bg-err/15 text-err"
      : req.risk === "uncertain"
        ? "bg-warn/15 text-warn"
        : "bg-ok/15 text-ok";
  const riskLabel =
    req.risk === "high" ? "High risk" : req.risk === "uncertain" ? "Uncertain risk" : "Low risk";
  return (
    <div ref={cardRef} role="dialog" aria-labelledby={`approval-title-${req.id}`} className="operator-popover pointer-events-auto w-full max-w-md p-4">
      <div className="flex items-center gap-2">
        <span className={`pill ${riskClass}`}>{riskLabel}</span>
        <span className="text-[12px] uppercase tracking-wide text-dim">
          {req.action.category.replace(/_/g, " ")}
        </span>
      </div>
      <h2 id={`approval-title-${req.id}`} className="mt-2 text-[14px] font-semibold tracking-tight">Permission required</h2>
      <p className="mt-1 text-[13px] text-dim">
        {req.action.description ?? "The agent wants to run a consequential action."}
      </p>
      {req.action.command ? (
        <pre className="mt-2 max-h-28 overflow-auto rounded-lg border border-line bg-bg/40 p-2 text-[12px]">
          {req.action.command}
        </pre>
      ) : null}
      {req.action.paths?.length ? (
        <ul className="mt-2 space-y-0.5 text-[12px] text-dim">
          {req.action.paths.map((p) => (
            <li key={p} className="truncate">
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-[13px] text-err">{error}</p> : null}
      {pending ? <p role="status" className="mt-2 text-[13px] text-dim">Sending decision…</p> : null}
      <fieldset disabled={pending} aria-busy={pending} className="mt-3 grid grid-cols-2 gap-2">
        <button
          disabled={pending}
          onClick={() => void respond("allow_once")}
          className="rounded-lg border border-line px-3 py-1.5 text-[13px] hover:border-accent"
        >
          Allow once
        </button>
        <button
          disabled={pending}
          onClick={() => void respond("allow_session")}
          className="rounded-lg border border-line px-3 py-1.5 text-[13px] hover:border-accent"
        >
          Allow for session
        </button>
        <button
          disabled={pending}
          onClick={() => void respond("allow_always")}
          className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-semibold text-bg hover:opacity-90"
        >
          Always allow
        </button>
        <button
          disabled={pending}
          onClick={() => void respond("deny")}
          className="rounded-lg border border-err bg-err/15 px-3 py-1.5 text-[13px] font-semibold text-err hover:bg-err/25"
        >
          Deny
        </button>
      </fieldset>
    </div>
  );
}
