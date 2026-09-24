import { useEffect, useState } from "react";
import Markdown from "./Markdown";
import { bridge } from "../bridge";

export type DesignArtifactKind = "brief" | "direction";

export interface DesignReviewSurfaceProps {
  kind: DesignArtifactKind;
  sessionFile: string;
  onClose(): void;
  /** Revising is ordinary conversation: close the surface and let the user
   *  talk to the agent. No backend operation, no state change. */
  onRevise(): void;
  onApproved(): void;
  onError(message: string): void;
}

const TITLE: Record<DesignArtifactKind, string> = {
  brief: "Brief",
  direction: "Design direction",
};

/**
 * The thing approval is actually about.
 *
 * The artifact lives in `.babylon/design/*.md` and previously only ever reached
 * the model, so "Approve" approved something the user had only seen as chat
 * prose. This shows the real text and binds the approval to its content hash:
 * if the agent rewrote it while the surface was open, approval is refused rather
 * than silently accepting text nobody read.
 */
export default function DesignReviewSurface({
  kind,
  sessionFile,
  onClose,
  onRevise,
  onApproved,
  onError,
}: DesignReviewSurfaceProps) {
  const [content, setContent] = useState<string | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bridge
      .designGetArtifact(sessionFile, kind)
      .then((artifact) => {
        if (cancelled) return;
        setContent(artifact.content);
        setRevision(artifact.revision);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "could not read the document");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionFile, kind]);

  const approve = () => {
    if (!revision || busy) return;
    setBusy(true);
    void bridge
      .designApproveArtifact(sessionFile, kind, revision)
      .then(() => {
        setBusy(false);
        onApproved();
      })
      .catch((err: unknown) => {
        setBusy(false);
        onError(err instanceof Error ? err.message : "could not approve");
      });
  };

  return (
    <div className="mx-3 mb-2 overflow-hidden rounded-lg border border-line bg-bg-soft/40">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[12px] font-semibold text-fg">{TITLE[kind]}</span>
        <button
          type="button"
          onClick={onClose}
          className="composer-pressable rounded px-1.5 py-0.5 text-[11px] text-dim hover:text-fg"
        >
          Close
        </button>
      </div>

      <div className="max-h-[46vh] overflow-y-auto px-4 py-3">
        {loadError ? (
          <p className="text-[13px] text-err">{loadError}</p>
        ) : content === null ? (
          <p className="text-[13px] text-dim">Loading…</p>
        ) : (
          <Markdown text={content} />
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2">
        <button
          type="button"
          onClick={onRevise}
          className="composer-pressable rounded-md border border-line px-2.5 py-1 text-[12px] text-fg hover:bg-bg-soft"
        >
          Revise
        </button>
        <button
          type="button"
          onClick={approve}
          disabled={revision === null || busy}
          className="composer-approve-enter rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-bg hover:bg-accent/90 disabled:opacity-50"
        >
          Approve &amp; continue
        </button>
      </div>
    </div>
  );
}
