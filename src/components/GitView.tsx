import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bridge,
  type ActivityUpdate,
  type GitBranchInfo,
  type GitChangedFile,
  type GitPrContext,
  type GitStatusDetails,
  type GitStatusResult,
} from "../bridge";
import { renderDiff, renderPlainDiff, type DiffRow } from "../lib/diff-highlight";
import { ArrowDownIcon, ArrowUpIcon, BranchIcon, CheckIcon, ChevronIcon, PlusIcon, RefreshIcon, XIcon } from "./icons";

interface Props {
  cwd?: string;
  sidebarStatus?: GitStatusResult | null;
  onChanged(): void;
  onClose(): void;
  toast(kind: "info" | "warning" | "error", message: string): void;
}

type Busy = null | "commit" | "commit-push" | "push" | "pull" | "switch" | "create-branch" | "pr-suggest" | "pr-create" | "diff";

type CommitPushProgress =
  | { phase: "idle" }
  | { phase: "generating"; message: string }
  | { phase: "committing"; message: string }
  | { phase: "pushing"; message: string }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string };

function subagentProgress(activity: string | null | undefined): { phase: "generating" | "committing" | "pushing"; message: string } {
  const message = activity?.trim() || "Inspecting repository changes";
  const lower = message.toLowerCase();
  if (lower.includes("git push") || lower.includes("pushing")) return { phase: "pushing", message };
  if (lower.includes("git commit") || lower.includes("git add") || lower.includes("committing")) {
    return { phase: "committing", message };
  }
  return { phase: "generating", message };
}

function lastReportLine(output: string | undefined): string {
  return output?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 500) ?? "";
}

// ---------------------------------------------------------------------------
// File tree: group changed paths into a nested directory structure.
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  file: GitChangedFile | null;
}

function buildTree(files: GitChangedFile[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map(), file: null };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      let child = node.children.get(segment);
      if (!child) {
        child = { name: segment, children: new Map(), file: null };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.children.set(parts[parts.length - 1], { name: parts[parts.length - 1], children: new Map(), file });
  }
  return root;
}

const statusGlyph: Record<string, string> = {
  M: "M",
  A: "A",
  D: "D",
  R: "R",
  C: "C",
  "?": "U",
};

function FileTree({
  node,
  prefix,
  depth,
  selected,
  collapsed,
  onToggleDir,
  onSelect,
}: {
  node: TreeNode;
  /** Directory path leading to this node ('' at the root). */
  prefix: string;
  depth: number;
  selected: string | null;
  collapsed: Set<string>;
  onToggleDir(path: string): void;
  onSelect(file: GitChangedFile): void;
}) {
  const entries = [...node.children.values()].sort((a, b) => {
    const aDir = !a.file;
    const bDir = !b.file;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <ul className="min-w-0">
      {entries.map((child) => {
        const path = child.file ? child.file.path : prefix ? `${prefix}/${child.name}` : child.name;
        return (
          <li key={path}>
            {child.file ? (
              <button
                onClick={() => onSelect(child.file!)}
                title={child.file.path}
                aria-current={selected === child.file!.path ? "true" : undefined}
                className={`group flex w-full items-baseline gap-1.5 border-l py-1.5 pr-2 text-left text-[12.5px] ${
                  selected === child.file!.path
                    ? "border-accent bg-inset text-fg"
                    : "border-transparent text-fg/80 hover:border-line-strong hover:bg-inset/60"
                }`}
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
              >
                <span className={`shrink-0 tabular-nums ${(child.file.status ?? "M") === "D" ? "text-err" : (child.file.status ?? "M") === "A" || (child.file.status ?? "") === "?" ? "text-ok" : "text-dim"}`}>
                  {statusGlyph[child.file.status ?? "M"] ?? child.file.status ?? "M"}
                </span>
                <span className="min-w-0 truncate">{child.name}</span>
                {child.file.insertions > 0 || child.file.deletions > 0 ? (
                  <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-dim">
                    <span className="text-ok">+{child.file.insertions}</span> <span className="text-err">−{child.file.deletions}</span>
                  </span>
                ) : null}
              </button>
            ) : (
              <>
                <button
                  onClick={() => onToggleDir(path)}
                  aria-expanded={!collapsed.has(path)}
                  className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-[12px] text-dim hover:text-fg"
                  style={{ paddingLeft: `${depth * 12 + 4}px` }}
                >
                  <ChevronIcon size={10} className={`shrink-0 transition-transform ${collapsed.has(path) ? "-rotate-90" : ""}`} />
                  <span className="truncate">{child.name}/</span>
                </button>
                {!collapsed.has(path) && (
                  <FileTree
                    node={child}
                    prefix={path}
                    depth={depth + 1}
                    selected={selected}
                    collapsed={collapsed}
                    onToggleDir={onToggleDir}
                    onSelect={onSelect}
                  />
                )}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Diff rendering: git-style rows with line numbers + shiki-highlighted code.
// ---------------------------------------------------------------------------

const DiffRowView = memo(function DiffRowView({ row }: { row: DiffRow }) {
  const glyph = row.kind === "add" ? "+" : row.kind === "del" ? "−" : "";
  const tint = row.kind === "add" ? "bg-ok/[0.09]" : row.kind === "del" ? "bg-err/[0.09]" : "";
  const meta = row.kind === "meta" || row.kind === "hunk";
  return (
    <div
      className={`git-diff-row flex w-full min-w-0 items-stretch font-mono text-[11.5px] leading-[1.65] ${tint} ${meta ? "text-dim" : ""} ${
        row.kind === "hunk" ? "my-1 border-y border-line/40 bg-inset/35 py-0.5" : ""
      }`}
    >
      <span className="flex shrink-0 self-stretch">
        <span className="w-8 select-none pr-1.5 text-right text-dim/60 tabular-nums">{row.oldLn ?? ""}</span>
        <span className="w-8 select-none pr-1.5 text-right text-dim/60 tabular-nums">{row.newLn ?? ""}</span>
        <span className={`w-4 select-none text-center ${row.kind === "add" ? "text-ok" : row.kind === "del" ? "text-err" : "opacity-50"}`}>
          {glyph}
        </span>
      </span>
      <span
        className={`git-diff-code min-w-0 flex-1 whitespace-pre-wrap break-words pr-5 ${meta ? "pl-2" : ""}`}
        dangerouslySetInnerHTML={{ __html: row.html || "&nbsp;" }}
      />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Main view.
// ---------------------------------------------------------------------------

export default function GitView({ cwd, sidebarStatus, onChanged, onClose, toast }: Props) {
  const [details, setDetails] = useState<GitStatusDetails | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [prCtx, setPrCtx] = useState<GitPrContext | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [commitPushProgress, setCommitPushProgress] = useState<CommitPushProgress>({ phase: "idle" });
  const [commitPushRunId, setCommitPushRunId] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [prForm, setPrForm] = useState<null | { title: string; body: string; baseBranch: string }>(null);
  /** Set when a branch switch was refused because of local changes; offers a stash-and-switch. */
  const [stashOffer, setStashOffer] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [rows, setRows] = useState<DiffRow[] | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(true);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [treeWidth, setTreeWidth] = useState(() => {
    const stored = Number(localStorage.getItem("pideck:git-tree-width"));
    return Number.isFinite(stored) && stored >= 180 && stored <= 420 ? stored : 300;
  });
  const bodyRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    setLoadingDetails(true);
    // Fast path first: render the tree/diff as soon as status lands (~50ms).
    const d = await bridge.gitStatusDetails(cwd).catch(() => null);
    setDetails(d);
    setLoadingDetails(false);
    onChanged();
    // Branches are cheap enough to fill after the tree paints.
    bridge
      .gitBranches(cwd)
      .then((b) => setBranches(b.branches))
      .catch(() => undefined);
  }, [cwd, onChanged]);

  useEffect(() => {
    setPrForm(null);
    setCreatingBranch(false);
    setCommitPushProgress({ phase: "idle" });
    setCommitPushRunId(null);
    setError(null);
    setPrCtx(null);
    setSelectedPath(null);
    setRows(null);
    void refresh();
  }, [refresh]);

  // `gh`/`glab` probing takes ~1.2s. Run it only after the Git view has been
  // stable for a moment; it never competes with status, diff, or shiki work.
  useEffect(() => {
    if (!cwd) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void bridge
        .gitPrContext(cwd)
        .then((context) => active && setPrCtx(context))
        .catch(() => undefined);
    }, 1500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [cwd]);

  // Keep the selection valid as the working tree changes; auto-select the
  // first file so the diff pane is never empty when changes exist.
  // Seed from the app-level poll while full details (per-file counts) load,
  // so the file list paints instantly on open.
  const seededFiles: GitChangedFile[] | null =
    details || !sidebarStatus?.dirty.length
      ? null
      : sidebarStatus.dirty.map((f) => ({ path: f.path, insertions: 0, deletions: 0, status: f.status === "??" ? "?" : f.status }));
  const files = useMemo(() => details?.files ?? seededFiles ?? [], [details, seededFiles]);
  useEffect(() => {
    if (!files.length) {
      setSelectedPath((prev) => (prev === null ? prev : null));
      return;
    }
    setSelectedPath((prev) => (prev && files.some((f) => f.path === prev) ? prev : files[0].path));
  }, [files]);

  useEffect(() => {
    if (!cwd || !selectedPath) {
      setRows(null);
      setRowsLoading(false);
      return;
    }
    let active = true;
    let frame = 0;
    setRowsLoading(true);
    bridge
      .gitDiffFile(cwd, selectedPath)
      .then((diff) => {
        if (!active) return;
        setRows(renderPlainDiff(diff));
        setRowsLoading(false);
        // Always paint the fast plain diff first; Shiki is a non-blocking
        // visual upgrade and is cached across sidebar closes.
        frame = requestAnimationFrame(() => {
          void renderDiff(diff, selectedPath).then((highlighted) => {
            if (active) setRows(highlighted);
          });
        });
      })
      .catch((e) => {
        if (!active) return;
        setRows([]);
        setRowsLoading(false);
        toast("error", e?.message ?? "failed to load diff");
      });
    return () => {
      active = false;
      if (frame) cancelAnimationFrame(frame);
    };
  }, [cwd, selectedPath, toast]);

  useEffect(() => {
    if (!commitPushRunId || !cwd) return;
    let active = true;
    let settled = false;

    const apply = async (update: ActivityUpdate) => {
      if (!active || settled) return;
      const run = update.subagents.find((item) => item.runId === commitPushRunId);
      if (!run) return;

      if (run.status === "starting" || run.status === "running") {
        setCommitPushProgress(subagentProgress(run.latestActivity));
        return;
      }

      if (run.status === "idle" || run.status === "completed") {
        settled = true;
        const current = await bridge.gitStatusDetails(cwd).catch(() => null);
        if (!active) return;
        const report = lastReportLine(run.output);
        if (current?.isRepo && !current.hasChanges && current.hasUpstream && current.ahead === 0) {
          const message = report || `Committed and pushed ${current.branch ?? "current branch"}`;
          setCommitPushProgress({ phase: "done", message });
          toast("info", message);
        } else if (current?.hasChanges) {
          setCommitPushProgress({ phase: "error", message: report || "Subagent stopped with uncommitted changes" });
        } else {
          setCommitPushProgress({ phase: "error", message: report || "Commit was created but the branch was not pushed" });
        }
        setBusy(null);
        setCommitPushRunId(null);
        await refresh().catch(() => undefined);
        return;
      }

      if (run.status === "failed" || run.status === "stopped" || run.status === "interrupted" || run.status === "routing_mismatch") {
        settled = true;
        setCommitPushProgress({
          phase: "error",
          message: run.stderr || lastReportLine(run.output) || run.latestActivity || `Subagent ${run.status}`,
        });
        setBusy(null);
        setCommitPushRunId(null);
        await refresh().catch(() => undefined);
      }
    };

    const unsubscribe = bridge.onActivityUpdate((update) => void apply(update));
    void bridge.activityList().then(apply).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [commitPushRunId, cwd, refresh, toast]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
  const ahead = details?.ahead ?? sidebarStatus?.ahead ?? 0;
  const behind = details?.behind ?? sidebarStatus?.behind ?? 0;
  const isRepo = details ? details.isRepo : sidebarStatus?.isRepo ?? false;

  const tree = useMemo(() => buildTree(files), [files]);
  const selectedFile = useMemo(() => files.find((file) => file.path === selectedPath) ?? null, [files, selectedPath]);

  const toggleDir = (path: string) =>
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const beginTreeResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? treeWidth;
    const available = bodyRef.current?.getBoundingClientRect().width ?? 600;
    const maxWidth = Math.max(180, Math.min(420, available - 180));
    document.documentElement.classList.add("is-git-tree-resizing");

    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("blur", finish);
      document.documentElement.classList.remove("is-git-tree-resizing");
      setTreeWidth((width) => {
        localStorage.setItem("pideck:git-tree-width", String(width));
        return width;
      });
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      setTreeWidth(Math.max(180, Math.min(maxWidth, startWidth + move.clientX - startX)));
    };
    const onEnd = (end: PointerEvent) => {
      if (end.pointerId === pointerId) finish();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("blur", finish);
  }, [treeWidth]);

  const onCommit = () =>
    void run("commit", async () => {
      await bridge.gitCommit(cwd!, commitMsg);
      setCommitMsg("");
      toast("info", "Changes committed");
    });

  const onPush = () =>
    void run("push", async () => {
      const res = await bridge.gitPush(cwd!);
      toast("info", res.status === "pushed" ? `Pushed ${res.branch}` : "Already up to date");
    });

  const onCommitPush = async () => {
    if (!cwd || busy !== null || files.length === 0) return;
    setBusy("commit-push");
    setError(null);
    setCommitPushProgress({ phase: "generating", message: "Starting commit subagent" });
    try {
      const result = await bridge.gitStartCommitPush(cwd);
      setCommitPushRunId(result.runId);
      setCommitPushProgress({ phase: "generating", message: `Subagent running with ${result.model}` });
    } catch (cause) {
      setBusy(null);
      setCommitPushProgress({ phase: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const onPull = () =>
    void run("pull", async () => {
      const res = await bridge.gitPull(cwd!);
      toast("info", res.status === "pulled" ? "Pulled latest changes" : "Already up to date");
    });

  const onSwitch = (name: string) =>
    void run("switch", async () => {
      try {
        await bridge.gitBranchSwitch(cwd!, name);
        toast("info", `Switched to ${name}`);
      } catch (e: any) {
        if (/commit or stash/i.test(String(e?.message))) {
          setStashOffer(name);
          return;
        }
        throw e;
      }
    });

  const onStashAndSwitch = (name: string) => {
    setStashOffer(null);
    void run("switch", async () => {
      const res = await bridge.gitBranchSwitch(cwd!, name, { stash: true });
      toast(
        "info",
        res.stashed ? `Switched to ${name} — changes stashed (restore with git stash pop)` : `Switched to ${name}`
      );
    });
  };

  const onCreateBranch = () =>
    void run("create-branch", async () => {
      await bridge.gitBranchCreate(cwd!, newBranchName, true);
      toast("info", `Created ${newBranchName.trim()}`);
      setNewBranchName("");
      setCreatingBranch(false);
    });

  const onOpenPrForm = () =>
    void run("pr-suggest", async () => {
      const suggested = await bridge.gitPrSuggest(cwd!);
      setPrForm({ title: suggested.title, body: suggested.body, baseBranch: suggested.baseBranch });
    });

  const onCreatePr = () => {
    if (!prForm) return;
    void run("pr-create", async () => {
      const res = await bridge.gitPrCreate(cwd!, { title: prForm.title, body: prForm.body });
      setPrForm(null);
      toast("info", res.status === "created" ? `Created PR ${res.number ? `#${res.number}` : ""}`.trim() : "PR already open");
      if (res.url) void bridge.openExternal(res.url).catch(() => {});
    });
  };

  return (
    <section aria-label="Git workspace" className="context-pane flex h-full min-w-0 flex-col">
      <div className="context-header flex h-16 shrink-0 items-center gap-2 px-4">
        <BranchIcon size={14} className="shrink-0 text-[var(--git)]" />
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
              className="min-w-0 max-w-[180px] truncate rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[15px] font-semibold tracking-tight outline-none hover:border-line disabled:opacity-50"
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
              className="context-icon-button shrink-0"
            >
              <PlusIcon size={13} />
            </button>
            <div className="ml-auto flex items-center gap-1.5">
              {(ahead > 0 || behind > 0) && (
                <span className="tabular-nums text-[12px] text-dim">
                  {ahead > 0 && <span className="mr-1 inline-flex items-center gap-0.5"><ArrowUpIcon size={10} />{ahead}</span>}
                  {behind > 0 && <span className="inline-flex items-center gap-0.5"><ArrowDownIcon size={10} />{behind}</span>}
                </span>
              )}
              <button
                onClick={() => void refresh()}
                disabled={busy !== null || loadingDetails}
                title="Refresh status"
                aria-label="Refresh git status"
                className="context-icon-button shrink-0"
              >
                <RefreshIcon size={13} />
              </button>
              <button onClick={onClose} aria-label="Close git view" className="context-icon-button">
                <XIcon size={12} />
              </button>
            </div>
          </>
        )}
      </div>

      {!isRepo && !loadingDetails ? (
        <div className="grid flex-1 place-items-center px-6 text-center text-[13px] text-dim">Not a git repository</div>
      ) : loadingDetails && !files.length ? (
        <div className="grid flex-1 place-items-center px-6 text-[13px] text-dim">Reading status…</div>
      ) : (
        <>
          <div ref={bodyRef} className="flex min-h-0 flex-1">
            {/* File tree */}
            <div
              className="relative shrink-0 border-r border-line/60"
              style={{ width: treeWidth, maxWidth: "calc(100% - 180px)" }}
            >
              <div className="h-full overflow-y-auto">
                <div className="sticky top-0 z-10 flex h-9 items-center justify-between border-b border-line/50 bg-[var(--context)] px-3 text-[11.5px] text-dim">
                <span>{files.length > 0 ? `Changes (${files.length})` : "Changes"}</span>
                {files.length > 0 && (
                  <span className="tabular-nums">
                    <span className="text-ok">+{details?.insertions ?? 0}</span>{" "}
                    <span className="text-err">−{details?.deletions ?? 0}</span>
                  </span>
                )}
              </div>
                {files.length > 0 ? (
                  <FileTree
                    node={tree}
                    prefix=""
                    depth={0}
                    selected={selectedPath}
                    collapsed={collapsedDirs}
                    onToggleDir={toggleDir}
                    onSelect={(file) => setSelectedPath(file.path)}
                  />
                ) : (
                  <p className="px-3 py-2 text-[12.5px] text-dim">Working tree clean</p>
                )}
              </div>
              <div
                className="git-tree-resizer"
                role="separator"
                aria-label="Resize changed files tree"
                aria-orientation="vertical"
                onPointerDown={beginTreeResize}
              />
            </div>

            {/* Diff */}
            <div className="flex min-w-0 flex-1 flex-col bg-bg/30" role="region" aria-label={`Diff of ${selectedPath ?? "nothing"}`} aria-busy={rowsLoading}>
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line/60 px-3">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg/80">{selectedPath ?? "No file selected"}</span>
                {selectedFile ? (
                  <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-dim">
                    <span className="text-ok">+{selectedFile.insertions}</span>{" "}
                    <span className="text-err">−{selectedFile.deletions}</span>
                  </span>
                ) : null}
              </div>
              <div className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-2 transition-opacity duration-150 ${rowsLoading && rows ? "opacity-55" : ""}`}>
                {selectedPath ? (
                  rows === null ? (
                    <p className="px-3 py-2 font-mono text-[11.5px] text-dim">{rowsLoading ? "Loading diff…" : "No textual changes."}</p>
                  ) : rows.length === 0 ? (
                    <p className="px-3 py-2 font-mono text-[11.5px] text-dim">No textual changes.</p>
                  ) : (
                    <div className="min-w-full font-mono">
                      {rows.map((row, i) => (
                        <DiffRowView key={i} row={row} />
                      ))}
                    </div>
                  )
                ) : (
                  <p className="px-3 py-2 text-[12.5px] text-dim">Select a file to see its diff.</p>
                )}
              </div>
            </div>
          </div>

          {/* Actions footer */}
          <div className="shrink-0 border-t border-line/60 px-3 py-2.5">
            <textarea
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && commitMsg.trim() && files.length > 0) onCommit();
              }}
              rows={1}
              placeholder="Commit message (⌘↵)"
              aria-label="Commit message"
              className="h-9 w-full resize-none rounded-md border border-line bg-inset px-2.5 py-2 text-[12.5px] outline-none placeholder:text-dim focus:border-accent"
            />
            <div className="mt-1.5 flex items-center gap-1.5">
              <button
                onClick={() => void onCommitPush()}
                disabled={busy !== null || files.length === 0}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg disabled:opacity-40"
              >
                <ArrowUpIcon size={10} />
                {busy === "commit-push" ? "Working…" : "Commit & push"}
              </button>
              <button
                onClick={onCommit}
                disabled={busy !== null || !commitMsg.trim() || files.length === 0}
                className="flex items-center gap-1.5 rounded-md bg-inset px-2.5 py-1.5 text-[12px] font-medium text-fg hover:bg-line/60 disabled:opacity-40"
              >
                <CheckIcon size={11} />
                {busy === "commit" ? "Committing…" : `Commit${files.length > 0 ? ` ${files.length}` : ""}`}
              </button>
              <button
                onClick={onPush}
                disabled={busy !== null || (ahead === 0 && !details?.hasChanges)}
                title="Push current branch"
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-fg hover:bg-inset disabled:opacity-35"
              >
                <ArrowUpIcon size={10} />
                {busy === "push" ? "Pushing…" : `Push${ahead > 0 ? ` ${ahead}` : ""}`}
              </button>
              <button
                onClick={onPull}
                disabled={busy !== null || !details?.hasUpstream}
                title={details?.hasUpstream ? "Pull upstream (fast-forward)" : "No upstream configured"}
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-fg hover:bg-inset disabled:opacity-35"
              >
                <ArrowDownIcon size={10} />
                {busy === "pull" ? "Pulling…" : `Pull${behind > 0 ? ` ${behind}` : ""}`}
              </button>
              {prCtx?.openPr ? (
                <button
                  onClick={() => prCtx.openPr?.url && void bridge.openExternal(prCtx.openPr.url).catch(() => {})}
                  title={prCtx.openPr.title}
                  className="ml-auto rounded-md bg-inset px-2 py-1.5 text-[12px] text-accent hover:bg-line/60"
                >
                  {prCtx.provider === "gitlab" ? "MR" : "PR"} #{prCtx.openPr.number}
                </button>
              ) : !prForm && prCtx?.tool?.installed && prCtx.tool.authenticated && !details?.hasChanges && (ahead > 0 || details?.hasUpstream) ? (
                <button onClick={onOpenPrForm} disabled={busy !== null} className="ml-auto rounded-md px-2 py-1.5 text-[12px] text-dim hover:bg-inset hover:text-fg disabled:opacity-35">
                  {busy === "pr-suggest" ? "Preparing…" : `Create ${prCtx.provider === "gitlab" ? "MR" : "PR"}`}
                </button>
              ) : null}
            </div>

            {commitPushProgress.phase !== "idle" ? (
              <div
                className={`mt-2 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] ${
                  commitPushProgress.phase === "error"
                    ? "bg-err/10 text-err"
                    : commitPushProgress.phase === "done"
                      ? "bg-ok/10 text-ok"
                      : "bg-inset text-dim"
                }`}
                role={commitPushProgress.phase === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    commitPushProgress.phase === "error"
                      ? "bg-err"
                      : commitPushProgress.phase === "done"
                        ? "bg-ok"
                        : "animate-pulse bg-accent"
                  }`}
                />
                <span className="min-w-0 break-words">{commitPushProgress.message}</span>
              </div>
            ) : null}

            {prForm ? (
              <div className="mt-2 border-t border-line/60 pt-2">
                <input
                  value={prForm.title}
                  onChange={(e) => setPrForm({ ...prForm, title: e.target.value })}
                  placeholder="Title"
                  aria-label="Pull request title"
                  className="w-full rounded-md border border-line bg-inset px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
                />
                <textarea
                  value={prForm.body}
                  onChange={(e) => setPrForm({ ...prForm, body: e.target.value })}
                  rows={3}
                  placeholder="Description"
                  aria-label="Pull request description"
                  className="mt-1.5 w-full resize-none rounded-md border border-line bg-inset px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
                />
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button onClick={onCreatePr} disabled={busy !== null || !prForm.title.trim()} className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg disabled:opacity-40">
                    {busy === "pr-create" ? "Creating…" : `Create ${prCtx?.provider === "gitlab" ? "MR" : "PR"} → ${prForm.baseBranch}`}
                  </button>
                  <button onClick={() => setPrForm(null)} className="rounded-md px-2 py-1.5 text-[12px] text-dim hover:bg-inset">Cancel</button>
                </div>
              </div>
            ) : null}

            {error && <div className="mt-2 rounded-md border border-err/30 bg-err/10 px-3 py-1.5 text-[12px] text-err">{error}</div>}
            {stashOffer && (
              <div className="mt-2 flex items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-1.5 text-[12px]">
                <span className="min-w-0 flex-1 text-warn">Local changes block switching to “{stashOffer}”.</span>
                <button
                  onClick={() => onStashAndSwitch(stashOffer)}
                  disabled={busy !== null}
                  className="shrink-0 rounded-md bg-inset px-2 py-1 text-[11.5px] font-medium text-fg hover:bg-line/60 disabled:opacity-40"
                >
                  Stash & switch
                </button>
                <button
                  onClick={() => setStashOffer(null)}
                  aria-label="Dismiss"
                  className="shrink-0 rounded-md p-1 text-dim hover:text-fg"
                >
                  <XIcon size={10} />
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
