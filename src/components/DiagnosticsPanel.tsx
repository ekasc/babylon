import type { DiagnosticsSnapshot } from "../diagnostics";

import { exportDiagnostics } from "../diagnostics";
import { useModalDialog } from "./useModalDialog";

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[12.5px]">
      <span className="text-dim">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

/**
 * Runtime diagnostics surface (Cross-cutting infrastructure). Read-only view
 * over an aggregate snapshot; the snapshot itself is safe to export because
 * collectDiagnostics never includes prompts, tool output, secrets, or source.
 */
export function DiagnosticsPanel({
  snapshot,
  onClose,
}: {
  snapshot: DiagnosticsSnapshot;
  onClose: () => void;
}) {
  const dialogRef = useModalDialog(onClose);
  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-[var(--scrim)] p-6" onMouseDown={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="diagnostics-title" className="modal-surface w-full max-w-lg p-5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 id="diagnostics-title" className="text-[15px] font-semibold tracking-tight">Runtime diagnostics</h2>
          <button onClick={onClose} className="rounded-lg border border-line px-2 py-1 text-[12.5px] hover:border-accent">
            Close
          </button>
        </div>
        <p className="mt-1 text-[11.5px] text-dim">
          Aggregates only. Exports contain no prompts, tool output, secrets, or source.
        </p>

        <div className="mt-4 space-y-3">
          <section>
            <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">System</div>
            <Row label="App version" value={snapshot.appVersion} />
            <Row label="Runtime version" value={snapshot.runtimeVersion} />
            <Row label="Generated at" value={new Date(snapshot.generatedAt).toLocaleTimeString()} />
          </section>

          <section className="border-t border-line pt-2">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">Work</div>
            <Row label="Unresolved attention" value={snapshot.attention.unresolved} />
          </section>

          {snapshot.backgroundPolicy ? (
            <section className="border-t border-line pt-2">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">Background policy</div>
              <Row label="Mode" value={snapshot.backgroundPolicy.mode} />
              <Row label="Max concurrent agents" value={snapshot.backgroundPolicy.maxConcurrentAgents} />
              <Row label="Max background cost" value={snapshot.backgroundPolicy.maxBackgroundCost} />
            </section>
          ) : null}

          {snapshot.events ? (
            <section className="border-t border-line pt-2">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">Event stream</div>
              <Row label="Total events" value={snapshot.events.total} />
              {snapshot.events.firstTs !== undefined ? (
                <Row label="Window" value={`${new Date(snapshot.events.firstTs).toLocaleTimeString()}, ${new Date(snapshot.events.lastTs ?? 0).toLocaleTimeString()}`} />
              ) : null}
              <div className="mt-1.5 text-[11.5px] text-dim">Observed event types</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {snapshot.events.observedTypes.map((type) => (
                  <span key={type} className="pill bg-raised text-fg">
                    {type} ×{snapshot.events?.byType[type] ?? 0}
                  </span>
                ))}
                {snapshot.events.observedTypes.length === 0 ? (
                  <span className="text-[12px] text-dim">No events recorded.</span>
                ) : null}
              </div>
              <div className="mt-1.5 text-[11.5px] text-dim">
                Unobserved event types <span className="text-dim/70">(not seen this session, not necessarily broken)</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {snapshot.events.unobservedTypes.map((type) => (
                  <span key={type} className="pill bg-raised text-dim/80">
                    {type}
                  </span>
                ))}
              </div>
              <div className="mt-1.5 text-[11.5px] text-dim">Ownership coverage</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {Object.entries(snapshot.events.ownershipCoverage)
                  .filter(([, count]) => count > 0)
                  .map(([key, count]) => (
                    <span key={key} className="pill bg-raised text-dim">
                      {key} ×{count}
                    </span>
                  ))}
                {Object.values(snapshot.events.ownershipCoverage).every((c) => c === 0) ? (
                  <span className="text-[12px] text-dim">No ownership ids stamped.</span>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>

        <button
          onClick={() => {
            // Optional chaining: clipboard is undefined outside secure contexts.
            navigator.clipboard?.writeText(exportDiagnostics(snapshot))?.catch(() => undefined);
          }}
          className="mt-4 w-full rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg hover:opacity-90"
        >
          Copy diagnostic export
        </button>
      </div>
    </div>
  );
}
