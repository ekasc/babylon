import {
  createProcess,
  detectPorts,
  listActive,
  listHistory,
  terminateProcess,
  type ProcessRegistry,
  type TrackedProcess,
} from "../process-model";

/**
 * Agent-Aware Terminal surface. Babylon tracks processes instead of treating
 * every terminal as an opaque shell: each tracked process shows command, cwd,
 * owning session/agent, pid, detected ports, and state. Active processes stay
 * interactive; exited ones remain in history. The model is in ../electron/
 * process-model so the main process can back this with real PTY spawns later.
 */
export function ProcessPanel({
  registry,
  setRegistry,
  onClose,
}: {
  registry: ProcessRegistry;
  setRegistry: (next: ProcessRegistry) => void;
  onClose: () => void;
}) {
  const active = listActive(registry);
  const history = listHistory(registry);

  const kill = (proc: TrackedProcess) =>
    setRegistry(terminateProcess(registry, proc.id, { state: "killed", exitCode: null as unknown as number }));

  const simulate = () => {
    const id = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let r = createProcess(registry, {
      id,
      command: "pnpm dev",
      cwd: "/project",
      owner: "Main Agent",
      ownerSession: "main",
      startedAt: Date.now(),
      state: "running",
    });
    r = detectPorts(r, id, [5173]);
    setRegistry(r);
  };

  return (
    <div className="process-panel">
      <div className="panel-head">
        <span className="panel-title">Processes</span>
        <div className="panel-head-actions">
          <button className="thread-action" onClick={simulate} title="Simulate a dev server (demo)">
            Simulate
          </button>
          <button className="thread-action" onClick={onClose} title="Close">
            Close
          </button>
        </div>
      </div>

      <div className="process-section">
        <div className="process-section-title">Active</div>
        {active.length === 0 ? (
          <p className="text-dim">No tracked processes. Agent or terminal activity appears here.</p>
        ) : (
          active.map((p) => (
            <div key={p.id} className="process-row">
              <span className="process-dot is-running" />
              <span className="process-command">{p.command}</span>
              <span className="process-meta">
                {p.owner ?? "shell"}
                {p.pid ? ` · pid ${p.pid}` : ""}
                {p.detectedPorts.length ? ` · :${p.detectedPorts.join(", :")}` : ""}
              </span>
              <button className="thread-action" onClick={() => kill(p)}>
                Kill
              </button>
            </div>
          ))
        )}
      </div>

      <div className="process-section">
        <div className="process-section-title">History</div>
        {history.length === 0 ? (
          <p className="text-dim">No exited processes yet.</p>
        ) : (
          history.map((p) => (
            <div key={p.id} className="process-row">
              <span className={`process-dot is-${p.state}`} />
              <span className="process-command">{p.command}</span>
              <span className="process-meta">
                {p.state}
                {typeof p.exitCode === "number" ? ` (${p.exitCode})` : ""}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
