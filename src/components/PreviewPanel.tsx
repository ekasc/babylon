import {
  detectServerFromCommand,
  registerServer,
  removeServer,
  updateServer,
  type PreviewRegistry,
  type TrackedServer,
} from "../preview-model";

function uniqueId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}`;
}

/**
 * Browser Preview surface. Babylon offers an integrated preview when it detects
 * a local HTTP server. This panel lists detected servers and lets the user open
 * or stop them; live port probing and the embedded webview come later.
 */
export function PreviewPanel({
  registry,
  setRegistry,
  onClose,
}: {
  registry: PreviewRegistry;
  setRegistry: (next: PreviewRegistry | ((prev: PreviewRegistry) => PreviewRegistry)) => void;
  onClose: () => void;
}) {
  const servers = Object.values(registry.servers);

  const stop = (s: TrackedServer) => setRegistry((prev) => removeServer(prev, s.id));

  const simulate = () => {
    const detected = detectServerFromCommand("pnpm dev") ?? { port: 5173, framework: "vite" };
    const id = uniqueId("srv");
    setRegistry((prev) =>
      registerServer(prev, {
        id,
        port: detected.port,
        framework: detected.framework,
        owner: "Main Agent",
        startedAt: Date.now(),
        state: "running",
      })
    );
  };

  return (
    <div className="preview-panel">
      <div className="panel-head">
        <span className="panel-title">Preview</span>
        <div className="panel-head-actions">
          <button className="thread-action" onClick={simulate} title="Simulate a detected server (demo)">
            Simulate
          </button>
          <button className="thread-action" onClick={onClose} title="Close">
            Close
          </button>
        </div>
      </div>

      {servers.length === 0 ? (
        <p className="text-dim">
          No local servers detected. Babylon surfaces a preview when a dev server starts (e.g. pnpm dev).
        </p>
      ) : (
        servers.map((s) => (
          <div key={s.id} className="preview-row">
            <span className="process-dot is-running" />
            <span className="preview-url">{s.url}</span>
            <span className="process-meta">{s.framework ?? "server"}</span>
            <a className="thread-action" href={s.url} target="_blank" rel="noreferrer">
              Open
            </a>
            <button className="thread-action" onClick={() => stop(s)}>
              Stop
            </button>
          </div>
        ))
      )}
    </div>
  );
}
