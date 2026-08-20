import { listAttention, resolveAttention, type AttentionItem, type AttentionRegistry } from "../attention";

/**
 * Attention Inbox surface (Phase 5). One global place for everything that needs
 * the user: permission requests, agent questions, failed/blocked tasks, merge
 * conflicts, missing credentials, environment failures, review requests. The
 * registry is local renderer state (the pure model lives in ../attention); the
 * runtime/daemon will back it with the same model later.
 */
export function AttentionPanel({
  registry,
  setRegistry,
  onClose,
}: {
  registry: AttentionRegistry;
  setRegistry: (next: AttentionRegistry | ((prev: AttentionRegistry) => AttentionRegistry)) => void;
  onClose: () => void;
}) {
  const items = listAttention(registry);

  const dismiss = (item: AttentionItem) => setRegistry((prev) => resolveAttention(prev, item.id));

  const clearAll = () => {
    let next = registry;
    for (const item of items) next = resolveAttention(next, item.id);
    setRegistry(next);
  };

  return (
    <div className="attention-panel">
      <div className="panel-head">
        <span className="panel-title">Attention</span>
        <div className="panel-head-actions">
          <button className="thread-action" onClick={clearAll} disabled={items.length === 0}>
            Clear all
          </button>
          <button className="thread-action" onClick={onClose} title="Close">
            Close
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-dim">Nothing needs your attention right now.</p>
      ) : (
        <div className="attention-list">
          {items.map((item) => (
            <div key={item.id} className="attention-row">
              <span className={`attention-dot is-${item.type}`} />
              <div className="attention-body">
                <div className="attention-title">{item.title}</div>
                {item.detail ? <div className="attention-detail">{item.detail}</div> : null}
                {item.source ? <div className="attention-source">{item.source}</div> : null}
              </div>
              <button className="thread-action" onClick={() => dismiss(item)}>
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
