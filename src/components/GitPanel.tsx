import { useCallback, useEffect, useRef, useState } from "react";
import { bridge, type GitBranchInfo, type GitPrContext, type GitStatusDetails, type GitStatusResult } from "../bridge";
import { ArrowDownIcon, ArrowUpIcon, BranchIcon, CheckIcon, PlusIcon } from "./icons";

interface Props {
  cwd?: string;
  sidebarStatus?: GitStatusResult | null;
  onChanged(): void;
  toast(kind: "info" | "warning" | "error", message: string): void;
}

type Busy = null | "commit" | "push" | "pull" | "switch" | "create-branch" | "pr-suggest" | "pr-create";

export default function GitPanel({ cwd, sidebarStatus, onChanged, toast }: Props) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<GitStatusDetails | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [prCtx, setPrCtx] = useState<GitPrContext | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [prForm, setPrForm] = useState<null | { title: string; body: string; baseBranch: string }>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    const [d, b, p] = await Promise.all([
      bridge.gitStatusDetails(cwd).catch(() => null),
      bridge.gitBranches(cwd).catch(() => ({ branches: [] as GitBranchInfo[], current: null })),
      bridge.gitPrContext(cwd).catch(() => null),
    ]);
    setDetails(d);
    setBranches(b.branches);
    setPrCtx(p);
    onChanged();
  }, [cwd, onChanged]);

  useEffect(() => {
    if (!open) return;
    setPrForm(null);
    setCreatingBranch(false);
    setError(null);
    void refresh();
  }, [open, cwd, refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (e: any) {
      setError(e?.message ?? "git action failed");
    } finally {
      setBusy(null);
      await refresh().catch(() => {});
    }
  };

  const branch = details?.branch ?? sidebarStatus?.branch ?? null;
  if (!cwd || (sidebarStatus && !sidebarStatus.isRepo && !details?.isRepo && !open)) return null;
  if (!branch && !open) return null;

  const dirtyCount = details?.files.length ?? sidebarStatus?.dirty.length ?? 0;
  const ahead = details?.ahead ?? sidebarStatus?.ahead ?? 0;
  const behind = details?.behind ?? sidebarStatus?.behind ?? 0;
  const isRepo = details ? details.isRepo : sidebarStatus?.isRepo ?? false;

  const onCommit = () =>
    void run("commit", async () => {
      await bridge.gitCommit(cwd, commitMsg);
      setCommitMsg("");
      toast("info", "Changes committed");
    });

  const onPush = () =>
    void run("push", async () => {
      const res = await bridge.gitPush(cwd);
      toast("info", res.status === "pushed" ? `Pushed ${res.branch}` : "Already up to date");
    });

  const onPull = () =>
    void run("pull", async () => {
      const res = await bridge.gitPull(cwd);
      toast("info", res.status === "pulled" ? "Pulled latest changes" : "Already up to date");
    });

  const onSwitch = (name: string) =>
    void run("switch", async () => {
      await bridge.gitBranchSwitch(cwd, name);
      toast("info", `Switched to ${name}`);
    });

  const onCreateBranch = () =>
    void run("create-branch", async () => {
      await bridge.gitBranchCreate(cwd, newBranchName, true);
      toast("info", `Created ${newBranchName.trim()}`);
      setNewBranchName("");
      setCreatingBranch(false);
    });

  const onOpenPrForm = () =>
    void run("pr-suggest", async () => {
      const suggested = await bridge.gitPrSuggest(cwd);
      setPrForm({ title: suggested.title, body: suggested.body, baseBranch: suggested.baseBranch });
    });

  const onCreatePr = () => {
    if (!prForm) return;
    void run("pr-create", async () => {
      const res = await bridge.gitPrCreate(cwd, { title: prForm.title, body: prForm.body });
      setPrForm(null);
      toast("info", res.status === "created" ? `Created PR ${res.number ? `#${res.number}` : ""}`.trim() : "PR already open");
      if (res.url) void bridge.openExternal(res.url).catch(() => {});
    });
  };

  const toolHint =
    prCtx?.tool && (!prCtx.tool.installed || !prCtx.tool.authenticated)
      ? !prCtx.tool.installed
        ? `${prCtx.tool.command} is not installed`
        : `${prCtx.tool.command} is not authenticated — run \`${prCtx.tool.command} auth login\``
      : null;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={isRepo ? `Git — ${branch ?? "detached HEAD"}` : "Git"}
        aria-expanded={open}
        className="operator-meta-control flex h-8 max-w-[220px] items-center gap-1.5 px-2.5 text-[13px]"
      >
        <BranchIcon size={12} className="shrink-0 text-[var(--git)]" />
        <span className="min-w-0 truncate">{branch ?? "git"}</span>
        {dirtyCount > 0 && <span className="shrink-0 rounded-full bg-white/8 px-1.5 text-[10.5px] tabular-nums text-dim">{dirtyCount}</span>}
        {ahead > 0 && (
          <span className="git-ahead flex shrink-0 items-center gap-0.5 tabular-nums">
            <ArrowUpIcon size={10} />
            {ahead}
          </span>
        )}
        {behind > 0 && (
          <span className="git-behind flex shrink-0 items-center gap-0.5 tabular-nums">
            <ArrowDownIcon size={10} />
            {behind}
          </span>
        )}
      </button>

      {open && (
        <div className="operator-popover absolute bottom-full left-0 z-50 mb-2 w-[380px] overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line/60 px-4 py-3">
            <BranchIcon size={13} className="shrink-0 text-[var(--git)]" />
            {creatingBranch ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <input
                  autoFocus
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newBranchName.trim()) onCreateBranch();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setCreatingBranch(false);
                    }
                  }}
                  placeholder="new-branch-name"
                  className="min-w-0 flex-1 rounded-md border border-line bg-inset px-2 py-1 text-[13px] outline-none focus:border-accent"
                />
                <button
                  onClick={onCreateBranch}
                  disabled={busy !== null || !newBranchName.trim()}
                  className="rounded-md bg-accent px-2 py-1 text-[12px] font-semibold text-bg disabled:opacity-40"
                >
                  Create
                </button>
                <button onClick={() => setCreatingBranch(false)} className="rounded-md px-1.5 py-1 text-[12px] text-dim hover:bg-inset">
                  Cancel
                </button>
              </span>
            ) : (
              <>
                <select
                  value={branch ?? ""}
                  onChange={(e) => e.target.value && e.target.value !== branch && onSwitch(e.target.value)}
                  disabled={busy !== null || branches.length === 0}
                  title="Switch branch"
                  className="min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[13px] font-semibold outline-none hover:border-line disabled:opacity-50"
                >
                  {branch && !branches.some((b) => b.name === branch) && <option value={branch}>{branch}</option>}
                  {branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setCreatingBranch(true)}
                  disabled={busy !== null}
                  title="New branch"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dim hover:bg-inset hover:text-fg disabled:opacity-40"
                >
                  <PlusIcon size={12} />
                </button>
              </>
            )}
          </div>

          {!isRepo ? (
            <div className="px-4 py-6 text-center text-[13px] text-dim">Not a git repository</div>
          ) : (
            <>
              <div className="max-h-[180px] overflow-y-auto px-4 py-2.5">
                {details && details.files.length > 0 ? (
                  <>
                    <div className="mb-1 flex items-baseline justify-between text-[12px] text-dim">
                      <span>
                        Changes ({details.files.length})
                      </span>
                      <span className="tabular-nums">
                        <span className="text-ok">+{details.insertions}</span> <span className="text-err">−{details.deletions}</span>
                      </span>
                    </div>
                    <ul>
                      {details.files.map((f) => (
                        <li key={f.path} className="flex items-baseline justify-between gap-3 py-0.5 text-[12.5px]" title={f.path}>
                          <span className="min-w-0 truncate text-fg/90">{f.path}</span>
                          <span className="shrink-0 tabular-nums text-dim">
                            <span className="text-ok">+{f.insertions}</span> <span className="text-err">−{f.deletions}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <div className="py-1 text-[12.5px] text-dim">Working tree clean</div>
                )}
              </div>

              <div className="border-t border-line/60 px-4 py-3">
                <textarea
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && commitMsg.trim() && dirtyCount > 0) onCommit();
                  }}
                  rows={2}
                  placeholder="Commit message (⌘↵ to commit)"
                  className="w-full resize-none rounded-md border border-line bg-inset px-2.5 py-2 text-[13px] outline-none placeholder:text-dim focus:border-accent"
                />
                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    onClick={onCommit}
                    disabled={busy !== null || !commitMsg.trim() || dirtyCount === 0}
                    className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg disabled:opacity-40"
                  >
                    <CheckIcon size={12} />
                    {busy === "commit" ? "Committing…" : `Commit${dirtyCount > 0 ? ` ${dirtyCount}` : ""}`}
                  </button>
                  <button
                    onClick={onPush}
                    disabled={busy !== null || (ahead === 0 && !details?.hasChanges)}
                    title="Push current branch"
                    className="flex items-center gap-1 rounded-md bg-inset px-2.5 py-1.5 text-[12.5px] text-fg hover:bg-line/60 disabled:opacity-40"
                  >
                    <ArrowUpIcon size={11} />
                    {busy === "push" ? "Pushing…" : `Push${ahead > 0 ? ` ${ahead}` : ""}`}
                  </button>
                  <button
                    onClick={onPull}
                    disabled={busy !== null || !details?.hasUpstream}
                    title={details?.hasUpstream ? "Pull upstream (fast-forward)" : "No upstream configured"}
                    className="flex items-center gap-1 rounded-md bg-inset px-2.5 py-1.5 text-[12.5px] text-fg hover:bg-line/60 disabled:opacity-40"
                  >
                    <ArrowDownIcon size={11} />
                    {busy === "pull" ? "Pulling…" : `Pull${behind > 0 ? ` ${behind}` : ""}`}
                  </button>
                </div>
              </div>

              <div className="border-t border-line/60 px-4 py-3">
                {prCtx?.openPr ? (
                  <button
                    onClick={() => prCtx.openPr?.url && void bridge.openExternal(prCtx.openPr.url).catch(() => {})}
                    title={prCtx.openPr.title}
                    className="flex w-full items-center gap-2 rounded-md bg-inset px-2.5 py-2 text-left text-[12.5px] hover:bg-line/60"
                  >
                    <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-accent">
                      {prCtx.provider === "gitlab" ? "MR" : "PR"} #{prCtx.openPr.number}
                    </span>
                    <span className="min-w-0 truncate text-fg">{prCtx.openPr.title}</span>
                  </button>
                ) : prForm ? (
                  <div>
                    <input
                      value={prForm.title}
                      onChange={(e) => setPrForm({ ...prForm, title: e.target.value })}
                      placeholder="Title"
                      className="w-full rounded-md border border-line bg-inset px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
                    />
                    <textarea
                      value={prForm.body}
                      onChange={(e) => setPrForm({ ...prForm, body: e.target.value })}
                      rows={4}
                      placeholder="Description"
                      className="mt-1.5 w-full resize-none rounded-md border border-line bg-inset px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
                    />
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <button
                        onClick={onCreatePr}
                        disabled={busy !== null || !prForm.title.trim()}
                        className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg disabled:opacity-40"
                      >
                        {busy === "pr-create" ? "Creating…" : `Create ${prCtx?.provider === "gitlab" ? "MR" : "PR"} → ${prForm.baseBranch}`}
                      </button>
                      <button onClick={() => setPrForm(null)} className="rounded-md px-2 py-1.5 text-[12.5px] text-dim hover:bg-inset">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={onOpenPrForm}
                      disabled={busy !== null || !!details?.hasChanges || (ahead === 0 && !details?.hasUpstream)}
                      title={
                        details?.hasChanges
                          ? "Commit local changes first"
                          : ahead === 0 && !details?.hasUpstream
                            ? "Push the branch first"
                            : `Create a ${prCtx?.provider === "gitlab" ? "merge" : "pull"} request`
                      }
                      className="rounded-md bg-inset px-2.5 py-1.5 text-[12.5px] text-fg hover:bg-line/60 disabled:opacity-40"
                    >
                      {busy === "pr-suggest" ? "Preparing…" : `Create ${prCtx?.provider === "gitlab" ? "MR" : "PR"}…`}
                    </button>
                    {toolHint && <span className="min-w-0 truncate text-[11.5px] text-dim">{toolHint}</span>}
                  </div>
                )}
              </div>
            </>
          )}

          {error && <div className="border-t border-err/30 bg-err/10 px-4 py-2 text-[12px] text-err">{error}</div>}
        </div>
      )}
    </div>
  );
}
