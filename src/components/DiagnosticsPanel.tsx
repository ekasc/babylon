import type { DiagnosticsSnapshot } from "../diagnostics";

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
  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" onMouseDown={onClose}>
      <div className="modal-surface w-full max-w-lg p-5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-semibold tracking-tight">Runtime diagnostics</h3>
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
            <Row label="Processes active / exited" value={`${snapshot.processes.active} / ${snapshot.processes.exited}`} />
            <Row
              label="Scheduled tasks"
              value={`${snapshot.automation.enabledTasks} of ${snapshot.automation.scheduledTasks} enabled`}
            />
            <Row label="Recorded automation runs" value={snapshot.automation.recordedRuns} />
          </section>

          {snapshot.backgroundPolicy ? (
            <section className="border-t border-line pt-2">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">Background policy</div>
              <Row label="Mode" value={snapshot.backgroundPolicy.mode} />
              <Row label="Max concurrent agents" value={snapshot.backgroundPolicy.maxConcurrentAgents} />
              <Row label="Max background cost" value={snapshot.backgroundPolicy.maxBackgroundCost} />
            </section>
          ) : null}

          {snapshot.devices ? (
            <section className="border-t border-line pt-2">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">Paired devices</div>
              <Row label="Active / revoked" value={`${snapshot.devices.paired} / ${snapshot.devices.revoked}`} />
            </section>
          ) : null}

          {snapshot.events ? (
            <section className="border-t border-line pt-2">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">Event stream</div>
              <Row label="Total events" value={snapshot.events.total} />
              {snapshot.events.firstTs !== undefined ? (
                <Row label="Window" value={`${new Date(snapshot.events.firstTs).toLocaleTimeString()} – ${new Date(snapshot.events.lastTs ?? 0).toLocaleTimeString()}`} />
              ) : null}
              <div className="mt-1 flex flex-wrap gap-1">
                {Object.entries(snapshot.events.byType).map(([type, count]) => (
                  <span key={type} className="pill bg-raised text-dim">
                    {type} ×{count}
                  </span>
                ))}
                {snapshot.events.total === 0 ? <span className="text-[12px] text-dim">No events recorded.</span> : null}
              </div>
            </section>
          ) : null}
        </div>

        <button
          onClick={() => {
            void navigator.clipboard
              .writeText(JSON.stringify(snapshot, null, 2))
              .catch(() => undefined);
          }}
          className="mt-4 w-full rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg hover:opacity-90"
        >
          Copy diagnostic export
        </button>
      </div>
    </div>
  );
}
