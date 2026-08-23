import { useState } from "react";
import { bridge } from "../bridge";
import { useFluidAppear } from "../lib/useSpring";
import { FlaskIcon } from "./icons";
import { useModalDialog } from "./useModalDialog";

export interface WorktreeInfo {
  isWorktree: boolean;
  sessionFile?: string;
  parentSession?: string;
  cwd?: string;
  git: { isRepo: boolean; root?: string; branch?: string; isLinkedWorktree?: boolean };
}

function shortPath(p?: string): string {
  if (!p) return "";
  return p.split("/").filter(Boolean).slice(-2).join("/");
}

function sanitizePreview(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "name"
  );
}

/** Banner shown while the active session is an experimental worktree. */
export function WorktreeBanner({
  info,
  busy,
  onExit,
}: {
  info: WorktreeInfo;
  busy: boolean;
  onExit(keep: boolean): void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-[12px]">
      <span className="text-warn">
        <FlaskIcon size={13} />
      </span>
      <span className="font-semibold">Experimental worktree</span>
      <span className="min-w-0 truncate text-dim">
        original preserved
        {info.git?.isLinkedWorktree && info.git.branch ? ` · isolated in ${info.git.branch}` : ""}
      </span>
      <div className="ml-auto flex shrink-0 gap-1.5">
        <button
          onClick={() => onExit(true)}
          disabled={busy}
          className="rounded-md border border-line bg-raised px-2 py-1 hover:bg-inset disabled:opacity-50"
          title="Return to the original session and keep this worktree"
        >
          Keep & return
        </button>
        <button
          onClick={() => onExit(false)}
          disabled={busy}
          className="rounded-md border border-err/40 px-2 py-1 text-err hover:bg-err/10 disabled:opacity-50"
          title="Return to the original session and delete this worktree"
        >
          Discard
        </button>
      </div>
    </div>
  );
}

/** Creation dialog. */
export function WorktreeModal({
  info,
  onClose,
  toast,
}: {
  info: WorktreeInfo;
  onClose(): void;
  toast(type: "info" | "warning" | "error", text: string): void;
}) {
  const [name, setName] = useState(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `exp-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  });
  const [description, setDescription] = useState("");
  const [useGit, setUseGit] = useState(false);
  const [busy, setBusy] = useState(false);
  const appear = useFluidAppear<HTMLDivElement>();
  const dialogRef = useModalDialog(onClose);
  const create = async () => {
    setBusy(true);
    try {
      const res = await bridge.worktreeCreate({ name, description, useGit: useGit && info.git.isRepo });
      toast(
        "info",
        res.gitWorktree
          ? `Worktree ready — files isolated in ${shortPath(res.gitWorktree.path)} (${res.gitWorktree.branch})`
          : "Worktree ready — original session preserved"
      );
      onClose();
    } catch (e: any) {
      toast("error", e?.message ?? "worktree creation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-[var(--scrim)] p-6" onMouseDown={onClose}>
      <div
        ref={(el) => {
          appear(el);
          dialogRef.current = el;
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="worktree-title"
        className="modal-surface w-full max-w-lg p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="worktree-title" className="flex items-center gap-2 text-[14px] font-semibold">
          <FlaskIcon size={16} className="text-warn" />
          New experimental worktree
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-dim">
          Clones this session into a separate worktree so you can try the change without touching the
          original conversation
          {info.git.isRepo ? " — with a git worktree, without touching these files either" : ""}.
        </p>

        <label className="mt-4 block text-[11px] font-semibold uppercase tracking-wider text-dim">
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent"
          placeholder="e.g. postgres-retry"
        />

        <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wider text-dim">
          The change to try (optional — sent as the first prompt)
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="mt-1 w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent"
          placeholder="e.g. Swap the SQLite layer for Postgres and see what breaks"
        />

        {info.git.isRepo ? (
          <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2.5">
            <input
              type="checkbox"
              checked={useGit}
              onChange={(e) => setUseGit(e.target.checked)}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <span className="text-[12.5px]">
              Also create a <b>git worktree</b> (branch{" "}
              <code className="text-[11px]">pideck/{sanitizePreview(name)}</code>)
              <span className="block text-[11px] text-dim">
                File edits happen in a separate checkout — your working tree stays untouched.
              </span>
            </span>
          </label>
        ) : (
          <p className="mt-3 rounded-md border border-line bg-bg px-3 py-2 text-[13px] text-dim">
            Not a git repository — session-only worktree (file edits still affect this folder).
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px]">
            Cancel
          </button>
          <button
            onClick={create}
            disabled={busy || !name.trim()}
            className="rounded-lg bg-accent px-4 py-1.5 text-[12.5px] font-semibold text-bg hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create worktree"}
          </button>
        </div>
      </div>
    </div>
  );
}
