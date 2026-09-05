import { useEffect, useRef, useState } from "react";

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
  const cardRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cancel = () => settle(request, request.kind === "input" ? null : false);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => {
      if (request.kind === "input") {
        inputRef.current?.focus();
        if (request.prefill) inputRef.current?.select();
      } else {
        cardRef.current?.querySelector<HTMLElement>("button")?.focus();
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Tab" && cardRef.current) {
        const focusable = [
          ...cardRef.current.querySelectorAll<HTMLElement>("button, input, textarea"),
        ];
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
  }, [request]);

  const confirmLabel = request.kind === "input" ? (request.confirmLabel ?? "Save") : (request.confirmLabel ?? "Confirm");

  return (
    <div className="fade-in fixed inset-0 z-[70] grid place-items-center bg-[var(--scrim)] p-6" onMouseDown={cancel}>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        className="modal-surface w-full max-w-md p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="prompt-title" className="text-[14px] font-semibold tracking-tight">{request.title}</h2>
        {request.message && <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-dim">{request.message}</p>}
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
            <button onClick={cancel} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px]">
              Cancel
            </button>
            <button
              onClick={() =>
                request.kind === "input"
                  ? value.trim() && settle(request, value.trim())
                  : settle(request, true)
              }
              disabled={request.kind === "input" && !value.trim()}
              className={`rounded-lg px-3 py-1.5 text-[12.5px] font-semibold ${
                request.kind === "confirm" && request.danger ? "bg-err text-white" : "bg-accent text-bg"
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
