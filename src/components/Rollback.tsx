import { useEffect, useRef } from "react";
import type { HistoryProjection, RollbackPlan } from "../bridge";
import { BranchIcon, XIcon } from "./icons";
import { useFluidAppear } from "../lib/useSpring";

export function RollbackConfirm({ plan, busy, onCancel, onConfirm }: { plan: RollbackPlan; busy: boolean; onCancel(): void; onConfirm(): void }) {
  const surface = useFluidAppear<HTMLDivElement>();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>("button")?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
      if (event.key !== "Tab" || !ref.current) return;
      const controls = [...ref.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [busy, onCancel]);

  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-[var(--scrim)] p-6" onMouseDown={() => !busy && onCancel()}>
      <div
        ref={(node) => { ref.current = node; surface(node); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rollback-title"
        className="modal-surface w-full max-w-[560px] p-5"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-warn/12 text-warn"><BranchIcon size={15} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="rollback-title" className="text-[16px] font-semibold tracking-[-0.015em]">Rollback from this turn?</h2>
            <p className="mt-1 line-clamp-3 text-[14px] leading-5 text-dim">“{plan.targetText}”</p>
          </div>
          <button onClick={onCancel} disabled={busy} aria-label="Cancel rollback" className="context-icon-button"><XIcon size={12} /></button>
        </div>

        <div className="rollback-summary mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line">
          <div><strong>{plan.abandonedCount}</strong><span>turn{plan.abandonedCount === 1 ? "" : "s"} leave the active path</span></div>
          <div><strong>{plan.changes.length}</strong><span>file{plan.changes.length === 1 ? "" : "s"} restored</span></div>
        </div>

        {plan.changes.length ? (
          <div className="mt-4 max-h-52 overflow-y-auto rounded-lg border border-line bg-bg/60 px-3 py-2">
            {plan.changes.map((change) => (
              <div key={change.path} className="flex min-w-0 items-center gap-2 py-1 text-[13px]">
                <span className={`rollback-file-status is-${change.status}`}>{change.status[0].toUpperCase()}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{change.path}</span>
              </div>
            ))}
          </div>
        ) : <p className="mt-4 text-[13px] text-dim">This rollback changes conversation history only; no checkpointed files changed.</p>}

        <p className="mt-4 text-[13px] leading-5 text-dim">
          The abandoned conversation is preserved. You can undo this rollback until you send another message or change branches.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="context-button">Cancel</button>
          <button onClick={onConfirm} disabled={busy} className="context-button is-primary px-4">
            {busy ? "Rolling back…" : "Rollback conversation and files"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RollbackDock({ rollback, busy, onUndo }: { rollback: NonNullable<HistoryProjection["activeRollback"]>; busy: boolean; onUndo(): void }) {
  return (
    <div className="rollback-dock mx-auto mb-2 flex w-[min(760px,calc(100%-40px))] items-center gap-3 px-4 py-2.5">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"><BranchIcon size={13} /></span>
      <div className="min-w-0 flex-1">
        <strong className="block text-[13px]">{rollback.abandonedCount} turn{rollback.abandonedCount === 1 ? "" : "s"} rolled back</strong>
        <span className="block truncate text-[12px] text-dim">{rollback.fileCount} file{rollback.fileCount === 1 ? "" : "s"} restored · original path preserved</span>
      </div>
      <button onClick={onUndo} disabled={busy || !rollback.undoAvailable} title={rollback.undoReason} className="context-button shrink-0">
        {busy ? "Restoring…" : "Undo rollback"}
      </button>
    </div>
  );
}
