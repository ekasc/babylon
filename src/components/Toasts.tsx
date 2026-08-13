import { useEffect } from "react";
import { XIcon } from "./icons";
import type { Toast } from "../store";

interface Props {
  toasts: Toast[];
  onDismiss(id: number): void;
}

export default function Toasts({ toasts, onDismiss }: Props) {
  return (
    <div aria-live="polite" aria-relevant="additions" className="pointer-events-none fixed bottom-12 right-4 z-50 flex w-[340px] flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss(id: number): void }) {
  useEffect(() => {
    const id = setTimeout(() => onDismiss(toast.id), 5000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);

  const color =
    toast.type === "error"
      ? "border-err/40 text-err"
      : toast.type === "warning"
        ? "border-warn/40 text-warn"
        : "border-line text-fg";

  return (
    <div role={toast.type === "error" ? "alert" : "status"} className={`toast pointer-events-auto flex items-start gap-2 rounded-xl border bg-raised px-3 py-2 text-[12.5px] shadow-lg ${color}`}>
      <span className="min-w-0 flex-1 break-words">{toast.text}</span>
      <button onClick={() => onDismiss(toast.id)} className="shrink-0 text-dim hover:text-fg">
        <XIcon size={11} />
      </button>
    </div>
  );
}
