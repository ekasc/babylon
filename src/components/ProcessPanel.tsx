import { useState } from "react";
import { bridge } from "../bridge";
import { listActive, listHistory, type ProcessRegistry } from "../process-model";

export function ProcessPanel({
  registry,
  setRegistry: _setRegistry,
  onClose,
  activeCwd,
}: {
  registry: ProcessRegistry;
  setRegistry?: (next: ProcessRegistry | ((prev: ProcessRegistry) => ProcessRegistry)) => void;
  onClose: () => void;
  activeCwd?: string;
}) {
  const active = listActive(registry);
  const history = listHistory(registry);
  const [command, setCommand] = useState("pnpm dev");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canRun = !!activeCwd && command.trim().length > 0 && !busy;

  const run = async () => {
    if (!activeCwd) {
      setError("No active project folder");
      return;
    }
    if (!command.trim()) {
      setError("Command is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bridge.processSpawn({ command: command.trim(), cwd: activeCwd });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const kill = async (id: string) => {
    setError(null);
    try {
      await bridge.processKill(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="process-panel">
      <div className="panel-head">
        <span className="panel-title">Processes</span>
        <div className="panel-head-actions">
          <button className="thread-action" onClick={onClose} title="Close">
            Close
          </button>
        </div>
      </div>

      <div className="process-run">
        <div className="text-dim" style={{ fontSize: 12, marginBottom: 6 }}>
          cwd: {activeCwd ?? "—"}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            aria-label="Command"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canRun) void run();
            }}
            placeholder="pnpm dev"
            className="process-input"
            style={{ flex: 1 }}
            disabled={busy}
          />
          <button className="thread-action" onClick={() => void run()} disabled={!canRun} title={canRun ? "Run in active project" : "Enter a command and open a project"}>
            {busy ? "Running…" : "Run"}
          </button>
        </div>
        {error ? (
          <div role="alert" className="text-err" style={{ marginTop: 8, fontSize: 12 }}>
            {error}
          </div>
        ) : null}
      </div>

      <div className="process-section">
        <div className="process-section-title">Active</div>
        {active.length === 0 ? (
          <p className="text-dim">No tracked processes. Run a command above or wait for activity.</p>
        ) : (
          active.map((p) => (
            <div key={p.id} className="process-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="process-dot is-running" />
                <span className="process-command">{p.command}</span>
                <span className="process-meta">
                  {p.owner ?? "shell"}
                  {typeof p.pid === "number" ? ` · pid ${p.pid}` : ""}
                  {p.detectedPorts.length ? ` · :${p.detectedPorts.join(", :")}` : ""}
                </span>
                <button className="thread-action" onClick={() => void kill(p.id)} style={{ marginLeft: "auto" }}>
                  Kill
                </button>
              </div>
              <div className="process-meta" style={{ fontSize: 11 }}>
                {p.cwd}
                {p.state ? ` · ${p.state}` : ""}
              </div>
              {p.output ? (
                <pre
                  className="process-output"
                  style={{
                    margin: 0,
                    padding: "8px",
                    background: "var(--bg-surface, #1a1a1a)",
                    borderRadius: 6,
                    maxHeight: 200,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontSize: 12,
                    lineHeight: 1.4,
                  }}
                >
                  {p.output}
                </pre>
              ) : null}
              {p.outputTruncated ? <span className="text-dim" style={{ fontSize: 11 }}>(output truncated to 256 KiB)</span> : null}
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
            <div key={p.id} className="process-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className={`process-dot is-${p.state}`} />
                <span className="process-command">{p.command}</span>
                <span className="process-meta">
                  {p.state}
                  {typeof p.exitCode === "number" ? ` (${p.exitCode})` : ""}
                  {p.detectedPorts.length ? ` · :${p.detectedPorts.join(", :")}` : ""}
                </span>
              </div>
              <div className="process-meta" style={{ fontSize: 11 }}>
                {p.cwd}
                {typeof p.pid === "number" ? ` · pid ${p.pid}` : ""}
              </div>
              {p.output ? (
                <pre
                  className="process-output"
                  style={{
                    margin: 0,
                    padding: "8px",
                    background: "var(--bg-surface, #1a1a1a)",
                    borderRadius: 6,
                    maxHeight: 200,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontSize: 12,
                    lineHeight: 1.4,
                  }}
                >
                  {p.output}
                </pre>
              ) : null}
              {p.outputTruncated ? <span className="text-dim" style={{ fontSize: 11 }}>(output truncated to 256 KiB)</span> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
