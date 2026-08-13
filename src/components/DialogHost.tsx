import { useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import { useFluidAppear } from "../lib/useSpring";
import type { Dialog } from "../store";

interface Props {
  dialogs: Dialog[];
  onDismiss(id: string): void;
  toast(type: "info" | "warning" | "error", text: string): void;
}

export default function DialogHost({ dialogs, onDismiss, toast }: Props) {
  if (!dialogs.length) return null;
  return <DialogCard key={dialogs[0].id} dialog={dialogs[0]} onDismiss={onDismiss} toast={toast} />;
}

function DialogCard({
  dialog,
  onDismiss,
  toast,
}: {
  dialog: Dialog;
  onDismiss(id: string): void;
  toast(type: "info" | "warning" | "error", text: string): void;
}) {
  const [value, setValue] = useState(dialog.prefill ?? "");
  const appear = useFluidAppear<HTMLDivElement>();
  const cardRef = useRef<HTMLDivElement | null>(null);

  const respond = async (payload: Record<string, unknown>) => {
    onDismiss(dialog.id);
    try {
      await bridge.uiRespond({ id: dialog.id, ...payload });
    } catch (e: any) {
      toast("error", e?.message ?? "failed to answer extension dialog");
    }
  };

  const cancel = () => void respond({ cancelled: true });

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => {
      const focusable = cardRef.current?.querySelector<HTMLElement>("button, input, textarea, [tabindex]:not([tabindex='-1'])");
      focusable?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
      if (e.key === "Tab" && cardRef.current) {
        const focusable = [...cardRef.current.querySelectorAll<HTMLElement>("button, input, textarea, [tabindex]:not([tabindex='-1'])")];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog.id]);

  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" onMouseDown={cancel}>
      <div
        ref={(node) => {
          cardRef.current = node;
          appear(node);
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`dialog-title-${dialog.id}`}
        className="modal-surface w-full max-w-md p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 id={`dialog-title-${dialog.id}`} className="text-[14px] font-semibold tracking-tight">{dialog.title ?? "Extension request"}</h3>
        {dialog.message && <p className="mt-1 text-[12.5px] text-dim">{dialog.message}</p>}

        <div className="mt-4">
          {dialog.method === "select" && (
            <div className="flex flex-col gap-1.5">
              {(dialog.options ?? []).map((o) => (
                <button
                  key={o}
                  onClick={() => void respond({ value: o })}
                  className="rounded-lg border border-line bg-bg px-3 py-2 text-left text-[13px] hover:border-accent"
                >
                  {o}
                </button>
              ))}
            </div>
          )}

          {dialog.method === "confirm" && (
            <div className="flex justify-end gap-2">
              <button onClick={cancel} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px]">
                Cancel
              </button>
              <button
                onClick={() => void respond({ confirmed: true })}
                className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg"
              >
                Confirm
              </button>
            </div>
          )}

          {(dialog.method === "input" || dialog.method === "editor") && (
            <div className="flex flex-col gap-2">
              {dialog.method === "input" ? (
                <input
                  autoFocus
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={dialog.placeholder}
                  onKeyDown={(e) => e.key === "Enter" && void respond({ value })}
                  className="rounded-lg border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent"
                />
              ) : (
                <textarea
                  autoFocus
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  rows={8}
                  className="resize-y rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[12px] outline-none focus:border-accent"
                />
              )}
              <div className="flex justify-end gap-2">
                <button onClick={cancel} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px]">
                  Cancel
                </button>
                <button
                  onClick={() => void respond({ value })}
                  className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg"
                >
                  Submit
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
