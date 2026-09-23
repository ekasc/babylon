import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import { ModalDialog } from "./ui/Dialog";
import { errorMessage } from "../lib/errors";

interface Props {
  cwd?: string;
  onClose(): void;
  toast(kind: "info" | "warning" | "error", msg: string): void;
  onChanged(): void;
}

export default function GitCommitPopover({ cwd, onClose, toast, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileCount, setFileCount] = useState<number | null>(null);

  useEffect(() => {
    if (!cwd) return;
    void bridge
      .gitStatusDetails(cwd)
      .then((d) => setFileCount(d?.files?.length ?? null))
      .catch(() => setFileCount(null));
  }, [cwd]);

  const onCommitPush = async () => {
    if (!cwd) return;
    setBusy(true);
    setError(null);
    const requestId = crypto.randomUUID();
    try {
      const res = await bridge.gitCommitPush(cwd, requestId);
      setPreview({ subject: res.generated.subject, body: res.generated.body });
      toast("info", `Committed ${res.commit.subject} — ${res.push.status === "skipped_up_to_date" ? "up to date" : "pushed"}`);
      onChanged();
      setTimeout(() => onClose(), 900);
    } catch (e) {
      setError(errorMessage(e, "commit failed"));
      toast("error", errorMessage(e, "commit failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      onClose={onClose}
      backdropClassName="fade-in fixed inset-0 z-50 bg-scrim"
      viewportClassName="fixed inset-0 z-50 grid place-items-center p-4"
      popupClassName="w-full max-w-[520px] rounded-xl border border-line bg-raised p-5 shadow-xl"
      ariaLabel="Commit and push"
    >
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-semibold tracking-tight">Commit & push</h3>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-dim hover:text-fg" aria-label="Close">
            ×
          </button>
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-dim">Stages all changes, generates a commit message via the model, and pushes to the current branch.</p>
        {error && <p className="mt-3 rounded-md border border-err/20 bg-err/10 px-3 py-2 text-[12px] text-err" role="alert">{error}</p>}
        {preview && (
          <div className="mt-3 rounded-lg border border-line bg-inset px-3 py-2.5 text-[13px]">
            <p className="font-medium">{preview.subject}</p>
            {preview.body && <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-dim">{preview.body}</p>}
          </div>
        )}
        <div className="mt-4 flex items-center gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-[13px] text-dim hover:bg-inset">
            Cancel
          </button>
          <button
            onClick={() => void onCommitPush()}
            disabled={busy}
            className="ml-auto rounded-lg bg-accent px-5 py-2 text-[13px] font-semibold text-bg shadow-sm hover:bg-accent/90 disabled:opacity-40"
          >
            {busy ? "Committing…" : fileCount !== null ? `Commit & push ${fileCount} file${fileCount === 1 ? "" : "s"}` : "Commit & push"}
          </button>
        </div>
    </ModalDialog>
  );
}
