import { useEffect, useState } from "react";
import { bridge, type ApprovalChoice, type ApprovalRequest } from "../bridge";

/**
 * Renders pending permission approvals raised by the Babylon permission engine
 * when an agent action needs interactive consent (supervised mode, or high /
 * uncertain risk under auto mode). Each card maps to one blocked tool call the
 * agent is waiting on; resolving it unblocks that call.
 */
export function ApprovalGate() {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);

  useEffect(() => {
    return bridge.onApprovalRequested((req) => {
      setRequests((prev) => [...prev, req]);
    });
  }, []);

  const resolve = async (id: string, choice: ApprovalChoice) => {
    setRequests((prev) => prev.filter((r) => r.id !== id));
    await bridge.permissionsResolveApproval(id, choice).catch(() => undefined);
  };

  if (requests.length === 0) return null;

  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-black/50 p-6">
      <div className="flex w-full max-w-md flex-col gap-3">
        {requests.map((req) => {
          const riskClass =
            req.risk === "high"
              ? "bg-err/15 text-err"
              : req.risk === "uncertain"
                ? "bg-warn/15 text-warn"
                : "bg-ok/15 text-ok";
          const riskLabel =
            req.risk === "high" ? "High risk" : req.risk === "uncertain" ? "Uncertain risk" : "Low risk";
          return (
            <div key={req.id} className="modal-surface p-5">
              <div className="flex items-center gap-2">
                <span className={`pill ${riskClass}`}>{riskLabel}</span>
                <span className="text-[11.5px] uppercase tracking-wide text-dim">
                  {req.action.category.replace(/_/g, " ")}
                </span>
              </div>
              <h3 className="mt-2 text-[15px] font-semibold tracking-tight">Permission required</h3>
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
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  onClick={() => resolve(req.id, "allow_once")}
                  className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] hover:border-accent"
                >
                  Allow once
                </button>
                <button
                  onClick={() => resolve(req.id, "allow_session")}
                  className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] hover:border-accent"
                >
                  Allow for session
                </button>
                <button
                  onClick={() => resolve(req.id, "allow_always")}
                  className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg hover:opacity-90"
                >
                  Always allow
                </button>
                <button
                  onClick={() => resolve(req.id, "deny")}
                  className="rounded-lg border border-err bg-err/15 px-3 py-1.5 text-[12.5px] font-semibold text-err hover:bg-err/25"
                >
                  Deny
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
