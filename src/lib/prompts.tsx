import { useEffect, useRef, useState } from "react";
import { ModalDialog } from "../components/ui/Dialog";

// Promise-based local dialogs sharing the DialogHost surface vocabulary.
// Host-driven extension dialogs flow through the store; these are renderer-
// local (rename, confirm delete, …) so they live outside the reducer.

interface PendingInput {
  kind: "input";
  title: string;
  message?: string;
  placeholder?: string;
  prefill?: string;
  confirmLabel?: string;
  resolve(value: string | null): void;
}

interface PendingConfirm {
  kind: "confirm";
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve(confirmed: boolean): void;
}

type Pending = PendingInput | PendingConfirm;

let pending: Pending[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function enqueue(request: Pending) {
  pending = [...pending, request];
  emit();
}

function settle(request: Pending, result: string | null | boolean) {
  pending = pending.filter((p) => p !== request);
  if (request.kind === "input") request.resolve(result as string | null);
  else request.resolve(result as boolean);
  emit();
}

export function promptText(opts: Omit<PendingInput, "kind" | "resolve">): Promise<string | null> {
  return new Promise((resolve) => enqueue({ kind: "input", ...opts, resolve }));
}

export function confirmAction(opts: Omit<PendingConfirm, "kind" | "resolve">): Promise<boolean> {
  return new Promise((resolve) => enqueue({ kind: "confirm", ...opts, resolve }));
}

export function PromptHost() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const current = pending[pending.length - 1];
  if (!current) return null;
  return <PromptCard key={pending.indexOf(current)} request={current} />;
}

function PromptCard({ request }: { request: Pending }) {
  const [value, setValue] = useState(request.kind === "input" ? (request.prefill ?? "") : "");
  const inputRef = useRef<HTMLInputElement>(null);

  const cancel = () => settle(request, request.kind === "input" ? null : false);

  // Select prefilled text once the input mounts; Base UI owns focus,
  // Escape, Tab trapping, and focus restoration via ModalDialog.
  useEffect(() => {
    if (request.kind !== "input" || !request.prefill) return;
    const id = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const confirmLabel = request.kind === "input" ? (request.confirmLabel ?? "Save") : (request.confirmLabel ?? "Confirm");

  return (
    <ModalDialog
      onClose={cancel}
      backdropClassName="fade-in fixed inset-0 z-[70] bg-[var(--scrim)]"
      viewportClassName="fixed inset-0 z-[70] grid place-items-center p-6"
      popupClassName="modal-surface w-full max-w-md p-5"
      ariaLabelledBy="prompt-title"
      initialFocus={request.kind === "input" ? inputRef : undefined}
    >
        <h2 id="prompt-title" className="text-[14px] font-semibold tracking-tight">{request.title}</h2>
        {request.message && <p className="mt-1 whitespace-pre-wrap text-[13px] text-dim">{request.message}</p>}
        <div className="mt-4 flex flex-col gap-3">
          {request.kind === "input" && (
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={request.placeholder}
              onKeyDown={(e) => e.key === "Enter" && value.trim() && settle(request, value.trim())}
              className="rounded-lg border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent"
            />
          )}
          <div className="flex justify-end gap-2">
            <button onClick={cancel} className="rounded-lg border border-line px-3 py-1.5 text-[13px]">
              Cancel
            </button>
            <button
              onClick={() =>
                request.kind === "input"
                  ? value.trim() && settle(request, value.trim())
                  : settle(request, true)
              }
              disabled={request.kind === "input" && !value.trim()}
              className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold ${
                request.kind === "confirm" && request.danger ? "bg-err text-white" : "bg-accent text-bg"
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
    </ModalDialog>
  );
}
