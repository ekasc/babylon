import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const COMMIT_TIMEOUT_MS = 10 * 60_000;
const PUSH_TIMEOUT_MS = 10 * 60_000;

export interface GitChangedFile {
  path: string;
  insertions: number;
  deletions: number;
}

export interface GitStatusDetails {
  isRepo: boolean;
  root?: string;
  branch: string | null;
  upstreamRef: string | null;
  hasUpstream: boolean;
  defaultBranch: string | null;
  isDefaultBranch: boolean;
  hasOriginRemote: boolean;
  isLinkedWorktree: boolean;
  ahead: number;
  behind: number;
  aheadOfDefault: number;
  hasChanges: boolean;
  files: GitChangedFile[];
  insertions: number;
  deletions: number;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  committedAt: number;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string;
  setUpstream?: boolean;
}

export interface GitPullResult {
  status: "pulled" | "skipped_up_to_date";
  branch: string;
  upstreamRef: string | null;
}

export interface GitCommitResult {
  commitSha: string;
  subject: string;
}

export type GitProviderKind = "github" | "gitlab" | "unknown";

export interface GitPrSummary {
  number: number;
  title: string;
  url: string;
  baseRef: string;
  headRef: string;
  state: "open" | "closed" | "merged";
}

export interface GitPrContext {
  provider: GitProviderKind;
  tool: { command: "gh" | "glab"; installed: boolean; authenticated: boolean } | null;
  openPr: GitPrSummary | null;
}

export interface GitPrCreateResult {
  status: "created" | "opened_existing";
  number?: number;
  url?: string;
  title: string;
  baseBranch: string;
  headBranch: string;
}

interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

async function runGit(args: string[], cwd: string, timeoutMs: number | null = DEFAULT_TIMEOUT_MS): Promise<GitRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs ?? undefined,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err: any) {
    if (typeof err?.code === "number") {
      return { exitCode: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    throw err;
  }
}

async function gitStdout(args: string[], cwd: string, timeoutMs: number | null = DEFAULT_TIMEOUT_MS): Promise<string> {
  const result = await runGit(args, cwd, timeoutMs);
  if (result.exitCode !== 0) {
    throw new GitError(firstLine(result.stderr) || `git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

function isNotRepoStderr(stderr: string): boolean {
  return stderr.toLowerCase().includes("not a git repository");
}

function isUnbornHeadStderr(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("unknown revision") ||
    lower.includes("bad revision") ||
    lower.includes("ambiguous argument 'head'") ||
    lower.includes("does not have any commits yet")
  );
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return { ahead: Number(match[1] ?? "0"), behind: Number(match[2] ?? "0") };
}

function parseNumstatEntries(stdout: string): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath = pathParts.length > 1 ? (pathParts.at(-1) ?? "").trim() : pathParts.join("\t").trim();
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    const renameArrowIndex = rawPath.indexOf(" => ");
    const normalizedPath = renameArrowIndex >= 0 ? rawPath.slice(renameArrowIndex + " => ".length).trim() : rawPath;
    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

function parsePorcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = line.slice(2).trim();
    return simple.length > 0 ? simple : null;
  }
  if (!(line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u "))) return null;
  const tabIndex = line.indexOf("\t");
  if (tabIndex >= 0) {
    const [filePath] = line.slice(tabIndex + 1).split("\t");
    return filePath?.trim().length ? filePath.trim() : null;
  }
  const parts = line.trim().split(/\s+/g);
  const filePath = parts.at(-1) ?? "";
  return filePath.length > 0 ? filePath : null;
}

async function resolveDefaultBranch(cwd: string): Promise<string | null> {
  const result = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (result.exitCode !== 0) return null;
  const ref = result.stdout.trim();
  const prefix = "refs/remotes/origin/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length).trim() || null : null;
}

async function originExists(cwd: string): Promise<boolean> {
  const result = await runGit(["remote", "get-url", "origin"], cwd);
  return result.exitCode === 0;
}

async function countAheadOfBase(cwd: string, defaultBranch: string | null): Promise<number> {
  const candidates = defaultBranch ? [`origin/${defaultBranch}`, defaultBranch] : [];
  for (const candidate of [...candidates, "origin/main", "origin/master", "main", "master"]) {
    const check = await runGit(["rev-parse", "--verify", "--quiet", candidate], cwd);
    if (check.exitCode !== 0) continue;
    const count = await runGit(["rev-list", "--count", `${candidate}..HEAD`], cwd);
    if (count.exitCode !== 0) continue;
    const parsed = Number.parseInt(count.stdout.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  return 0;
}

const NON_REPO_STATUS: GitStatusDetails = {
  isRepo: false,
  branch: null,
  upstreamRef: null,
  hasUpstream: false,
  defaultBranch: null,
  isDefaultBranch: false,
  hasOriginRemote: false,
  isLinkedWorktree: false,
  ahead: 0,
  behind: 0,
  aheadOfDefault: 0,
  hasChanges: false,
  files: [],
  insertions: 0,
  deletions: 0,
};

export async function statusDetails(cwd: string): Promise<GitStatusDetails> {
  const status = await runGit(["status", "--porcelain=2", "--branch"], cwd);
  if (status.exitCode !== 0) {
    if (isNotRepoStderr(status.stderr)) return NON_REPO_STATUS;
    throw new GitError(firstLine(status.stderr) || "git status failed");
  }

  let branch: string | null = null;
  let upstreamRef: string | null = null;
  let ahead = 0;
  let behind = 0;
  let hasChanges = false;
  const changedWithoutNumstat = new Set<string>();

  for (const line of status.stdout.split(/\r?\n/g)) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      branch = value.startsWith("(") ? null : value;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      const value = line.slice("# branch.upstream ".length).trim();
      upstreamRef = value.length > 0 ? value : null;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      ({ ahead, behind } = parseBranchAb(line.slice("# branch.ab ".length).trim()));
      continue;
    }
    if (line.trim().length > 0 && !line.startsWith("#")) {
      hasChanges = true;
      const pathValue = parsePorcelainPath(line);
      if (pathValue) changedWithoutNumstat.add(pathValue);
    }
  }

  let numstatStdout = "";
  const numstat = await runGit(["diff", "HEAD", "--numstat", "--"], cwd);
  if (numstat.exitCode === 0) {
    numstatStdout = numstat.stdout;
  } else if (isUnbornHeadStderr(numstat.stderr)) {
    const [unstaged, staged] = await Promise.all([
      gitStdout(["diff", "--numstat"], cwd).catch(() => ""),
      gitStdout(["diff", "--cached", "--numstat"], cwd).catch(() => ""),
    ]);
    const merged = new Map<string, { insertions: number; deletions: number }>();
    for (const entry of [...parseNumstatEntries(staged), ...parseNumstatEntries(unstaged)]) {
      const existing = merged.get(entry.path) ?? { insertions: 0, deletions: 0 };
      existing.insertions += entry.insertions;
      existing.deletions += entry.deletions;
      merged.set(entry.path, existing);
    }
    numstatStdout = Array.from(merged.entries())
      .map(([p, s]) => `${s.insertions}\t${s.deletions}\t${p}`)
      .join("\n");
  }

  const [defaultBranch, hasOriginRemote, root, gitDir] = await Promise.all([
    resolveDefaultBranch(cwd),
    originExists(cwd),
    gitStdout(["rev-parse", "--show-toplevel"], cwd).catch(() => undefined),
    gitStdout(["rev-parse", "--git-dir"], cwd).catch(() => ""),
  ]);

  // An untracked branch has no upstream, so ahead/behind read as 0/0; express
  // its unpublished commits against the default branch instead.
  if (!upstreamRef && branch) {
    ahead = await countAheadOfBase(cwd, defaultBranch);
    behind = 0;
  }

  const isDefaultBranch =
    branch !== null &&
    (branch === defaultBranch || (defaultBranch === null && (branch === "main" || branch === "master")));
  const aheadOfDefault = branch && !isDefaultBranch ? await countAheadOfBase(cwd, defaultBranch) : 0;

  const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
  for (const entry of parseNumstatEntries(numstatStdout)) {
    fileStatMap.set(entry.path, { insertions: entry.insertions, deletions: entry.deletions });
  }
  let insertions = 0;
  let deletions = 0;
  const files: GitChangedFile[] = Array.from(fileStatMap.entries())
    .map(([path, stat]) => {
      insertions += stat.insertions;
      deletions += stat.deletions;
      return { path, insertions: stat.insertions, deletions: stat.deletions };
    });
  for (const path of changedWithoutNumstat) {
    if (!fileStatMap.has(path)) files.push({ path, insertions: 0, deletions: 0 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    isRepo: true,
    root,
    branch,
    upstreamRef,
    hasUpstream: upstreamRef !== null,
    defaultBranch,
    isDefaultBranch,
    hasOriginRemote,
    isLinkedWorktree: gitDir.replace(/\\/g, "/").includes(".git/worktrees/") || gitDir.includes("/worktrees/"),
    ahead,
    behind,
    aheadOfDefault,
    hasChanges,
    files,
    insertions,
    deletions,
  };
}

// ---------------------------------------------------------------------------
// Commit / push / pull
// ---------------------------------------------------------------------------

export async function commitAll(cwd: string, message: string): Promise<GitCommitResult> {
  const normalized = message.replace(/\r\n/g, "\n").trim();
  if (!normalized) throw new GitError("commit message is required");
  const [subject, ...rest] = normalized.split("\n");
  const body = rest.join("\n").trim();

  const details = await statusDetails(cwd);
  if (!details.isRepo) throw new GitError("not a git repository");
  if (!details.hasChanges) throw new GitError("no changes to commit");

  await gitStdout(["add", "-A"], cwd);
  const args = ["commit", "-m", subject.trim()];
  if (body.length > 0) args.push("-m", body);
  const result = await runGit(args, cwd, COMMIT_TIMEOUT_MS);
  if (result.exitCode !== 0) throw new GitError(firstLine(result.stderr) || "git commit failed");
  const commitSha = await gitStdout(["rev-parse", "HEAD"], cwd);
  return { commitSha, subject: subject.trim() };
}

async function resolveCurrentUpstream(cwd: string, upstreamRef: string): Promise<{ remoteName: string; branchName: string } | null> {
  const separatorIndex = upstreamRef.indexOf("/");
  if (separatorIndex <= 0) return null;
  const remoteName = upstreamRef.slice(0, separatorIndex).trim();
  const branchName = upstreamRef.slice(separatorIndex + 1).trim();
  if (!remoteName || !branchName) return null;
  return { remoteName, branchName };
}

async function resolvePushRemoteName(cwd: string): Promise<string | null> {
  const origin = await runGit(["remote", "get-url", "origin"], cwd);
  if (origin.exitCode === 0) return "origin";
  const remotes = await runGit(["remote"], cwd);
  if (remotes.exitCode !== 0) return null;
  const names = remotes.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return names.length === 1 ? names[0] : null;
}

export async function pushCurrentBranch(cwd: string): Promise<GitPushResult> {
  const details = await statusDetails(cwd);
  if (!details.isRepo) throw new GitError("not a git repository");
  const branch = details.branch;
  if (!branch) throw new GitError("cannot push from detached HEAD");

  if (details.ahead === 0 && details.behind === 0 && details.hasUpstream) {
    return { status: "skipped_up_to_date", branch, ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}) };
  }

  if (!details.hasUpstream) {
    const remoteName = await resolvePushRemoteName(cwd);
    if (!remoteName) throw new GitError("cannot push because no git remote is configured for this repository");
    await gitStdout(["push", "-u", remoteName, `HEAD:refs/heads/${branch}`], cwd, PUSH_TIMEOUT_MS);
    return { status: "pushed", branch, upstreamBranch: `${remoteName}/${branch}`, setUpstream: true };
  }

  const upstream = await resolveCurrentUpstream(cwd, details.upstreamRef!);
  if (upstream) {
    await gitStdout(["push", upstream.remoteName, `HEAD:refs/heads/${upstream.branchName}`], cwd, PUSH_TIMEOUT_MS);
    return { status: "pushed", branch, upstreamBranch: details.upstreamRef!, setUpstream: false };
  }

  await gitStdout(["push"], cwd, PUSH_TIMEOUT_MS);
  return { status: "pushed", branch, ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}), setUpstream: false };
}

export async function pullCurrentBranch(cwd: string): Promise<GitPullResult> {
  const details = await statusDetails(cwd);
  if (!details.isRepo) throw new GitError("not a git repository");
  if (!details.branch) throw new GitError("cannot pull from detached HEAD");
  if (!details.hasUpstream) throw new GitError("current branch has no upstream configured — push with upstream first");

  const beforeSha = await gitStdout(["rev-parse", "HEAD"], cwd).catch(() => "");
  const result = await runGit(["pull", "--ff-only"], cwd, DEFAULT_TIMEOUT_MS);
  if (result.exitCode !== 0) throw new GitError(firstLine(result.stderr) || "git pull failed");
  const afterSha = await gitStdout(["rev-parse", "HEAD"], cwd).catch(() => "");
  const refreshed = await statusDetails(cwd);
  return {
    status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
    branch: details.branch,
    upstreamRef: refreshed.upstreamRef,
  };
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export async function listBranches(cwd: string): Promise<{ branches: GitBranchInfo[]; current: string | null }> {
  const result = await runGit(
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)\t%(committerdate:unix)", "refs/heads"],
    cwd
  );
  if (result.exitCode !== 0) {
    if (isNotRepoStderr(result.stderr)) return { branches: [], current: null };
    throw new GitError(firstLine(result.stderr) || "git branch list failed");
  }
  const current = await gitStdout(["branch", "--show-current"], cwd).catch(() => "");
  const branches: GitBranchInfo[] = [];
  for (const line of result.stdout.split(/\r?\n/g)) {
    const [name, at] = line.split("\t");
    const trimmed = name?.trim();
    if (!trimmed) continue;
    branches.push({ name: trimmed, current: trimmed === current, committedAt: Number.parseInt(at ?? "0", 10) || 0 });
  }
  return { branches, current: current || null };
}

const BRANCH_NAME_RE = /^[A-Za-z0-9._\/-]+$/;

export function validateBranchName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new GitError("branch name is required");
  if (trimmed.length > 200) throw new GitError("branch name is too long");
  if (!BRANCH_NAME_RE.test(trimmed) || trimmed.startsWith("-") || trimmed.endsWith("/") || trimmed.includes("//")) {
    throw new GitError("invalid branch name");
  }
  return trimmed;
}

export async function createBranch(cwd: string, name: string, switchTo: boolean): Promise<{ branch: string }> {
  const branch = validateBranchName(name);
  const exists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
  if (exists.exitCode === 0) throw new GitError(`branch "${branch}" already exists`);
  const result = await runGit(["branch", branch], cwd);
  if (result.exitCode !== 0) throw new GitError(firstLine(result.stderr) || "git branch create failed");
  if (switchTo) await switchBranch(cwd, branch);
  return { branch };
}

export async function switchBranch(cwd: string, name: string): Promise<{ branch: string | null }> {
  const refName = validateBranchName(name);
  const dirty = await statusDetails(cwd);
  if (dirty.hasChanges) {
    throw new GitError("commit or stash local changes before switching branches");
  }

  const [localCheck, remoteCheck] = await Promise.all([
    runGit(["show-ref", "--verify", "--quiet", `refs/heads/${refName}`], cwd),
    runGit(["show-ref", "--verify", "--quiet", `refs/remotes/${refName}`], cwd),
  ]);
  const localExists = localCheck.exitCode === 0;
  const remoteExists = remoteCheck.exitCode === 0;

  const checkoutArgs = localExists
    ? ["checkout", refName]
    : remoteExists
      ? ["checkout", "--track", refName]
      : ["checkout", refName];
  const result = await runGit(checkoutArgs, cwd);
  if (result.exitCode !== 0) throw new GitError(firstLine(result.stderr) || "git checkout failed");
  const branch = await gitStdout(["branch", "--show-current"], cwd).catch(() => "");
  return { branch: branch || null };
}

// ---------------------------------------------------------------------------
// Hosting providers (GitHub via gh, GitLab via glab)
// ---------------------------------------------------------------------------

export function detectProviderFromRemoteUrl(remoteUrl: string): GitProviderKind {
  const url = remoteUrl.trim().toLowerCase();
  if (!url) return "unknown";
  if (url.includes("github.com")) return "github";
  if (url.includes("gitlab.com") || url.includes("gitlab.")) return "gitlab";
  return "unknown";
}

async function resolvePrimaryRemoteUrl(cwd: string): Promise<string | null> {
  const origin = await runGit(["remote", "get-url", "origin"], cwd);
  if (origin.exitCode === 0) return origin.stdout.trim();
  const remotes = await runGit(["remote", "-v"], cwd);
  if (remotes.exitCode !== 0) return null;
  const line = remotes.stdout.split("\n").find((l) => l.includes("(push)"));
  const parts = line?.trim().split(/\s+/);
  return parts?.[1] ?? null;
}

async function toolAvailable(command: "gh" | "glab"): Promise<{ installed: boolean; authenticated: boolean }> {
  let installed = false;
  try {
    await execFileAsync(command, ["--version"], { timeout: 5_000 });
    installed = true;
  } catch {
    return { installed: false, authenticated: false };
  }
  try {
    const authArgs = command === "gh" ? ["auth", "status"] : ["auth", "status"];
    await execFileAsync(command, authArgs, { timeout: 10_000 });
    return { installed, authenticated: true };
  } catch (err: any) {
    // gh exits non-zero when signed out but prints "Logged in to ..." lines when authed.
    const combined = `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
    return { installed, authenticated: /logged in to/i.test(combined) };
  }
}

async function ghListOpenPrs(cwd: string, headSelector: string): Promise<GitPrSummary[]> {
  const { stdout } = await execFileAsync(
    "gh",
    ["pr", "list", "--head", headSelector, "--state", "open", "--limit", "5", "--json", "number,title,url,baseRefName,headRefName,state"],
    { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
  );
  const raw = stdout.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item: any) => ({
    number: Number(item.number),
    title: String(item.title ?? ""),
    url: String(item.url ?? ""),
    baseRef: String(item.baseRefName ?? ""),
    headRef: String(item.headRefName ?? ""),
    state: "open" as const,
  }));
}

async function glabListOpenMrs(cwd: string, sourceBranch: string): Promise<GitPrSummary[]> {
  const { stdout } = await execFileAsync(
    "glab",
    ["api", `projects/:fullpath/merge_requests?state=opened&source_branch=${encodeURIComponent(sourceBranch)}&per_page=5`],
    { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
  );
  const raw = stdout.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item: any) => ({
    number: Number(item.iid),
    title: String(item.title ?? ""),
    url: String(item.web_url ?? ""),
    baseRef: String(item.target_branch ?? ""),
    headRef: String(item.source_branch ?? ""),
    state: "open" as const,
  }));
}

async function findOpenPr(cwd: string, provider: GitProviderKind, branch: string): Promise<GitPrSummary | null> {
  try {
    if (provider === "github") {
      const prs = await ghListOpenPrs(cwd, branch);
      return prs.find((pr) => pr.headRef === branch) ?? prs[0] ?? null;
    }
    if (provider === "gitlab") {
      const mrs = await glabListOpenMrs(cwd, branch);
      return mrs.find((mr) => mr.headRef === branch) ?? mrs[0] ?? null;
    }
  } catch {
    /* provider lookup is best-effort */
  }
  return null;
}

export async function prContext(cwd: string): Promise<GitPrContext> {
  const details = await statusDetails(cwd);
  if (!details.isRepo || !details.branch) {
    return { provider: "unknown", tool: null, openPr: null };
  }
  const remoteUrl = await resolvePrimaryRemoteUrl(cwd);
  const provider = remoteUrl ? detectProviderFromRemoteUrl(remoteUrl) : "unknown";
  if (provider === "unknown") return { provider, tool: null, openPr: null };

  const command = provider === "github" ? "gh" : "glab";
  const { installed, authenticated } = await toolAvailable(command);
  const openPr = installed && authenticated ? await findOpenPr(cwd, provider, details.branch) : null;
  return { provider, tool: { command, installed, authenticated }, openPr };
}

async function resolvePrBaseBranch(cwd: string, details: GitStatusDetails): Promise<string> {
  if (details.upstreamRef) {
    const upstream = await resolveCurrentUpstream(cwd, details.upstreamRef);
    if (upstream && upstream.branchName && upstream.branchName !== details.branch) {
      return upstream.branchName;
    }
  }
  if (details.defaultBranch) return details.defaultBranch;
  return "main";
}

export async function suggestPrContent(
  cwd: string
): Promise<{ title: string; body: string; baseBranch: string; headBranch: string }> {
  const details = await statusDetails(cwd);
  if (!details.isRepo || !details.branch) throw new GitError("cannot prepare a PR outside a branch");
  const baseBranch = await resolvePrBaseBranch(cwd, details);
  const range = `${baseBranch}..HEAD`;
  const log = await runGit(["log", "--oneline", "--no-merges", range], cwd);
  const commits = log.exitCode === 0 ? log.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];

  let title: string;
  if (commits.length === 1) {
    title = commits[0].replace(/^[0-9a-f]+\s+/, "");
  } else if (commits.length > 1) {
    title = `${details.branch}: ${commits.length} commits`;
  } else {
    title = details.branch;
  }
  const body = commits.length > 0 ? commits.map((c) => `- ${c.replace(/^[0-9a-f]+\s+/, "")}`).join("\n") : "";
  return { title: title.slice(0, 200), body, baseBranch, headBranch: details.branch };
}

export async function createPr(cwd: string, input: { title: string; body?: string }): Promise<GitPrCreateResult> {
  const title = input.title.trim();
  if (!title) throw new GitError("PR title is required");
  const details = await statusDetails(cwd);
  if (!details.isRepo || !details.branch) throw new GitError("cannot create a PR outside a branch");
  if (details.hasChanges) throw new GitError("commit local changes before creating a PR");
  if (!details.hasUpstream && details.ahead === 0) {
    throw new GitError("current branch has not been pushed — push before creating a PR");
  }

  const remoteUrl = await resolvePrimaryRemoteUrl(cwd);
  const provider = remoteUrl ? detectProviderFromRemoteUrl(remoteUrl) : "unknown";
  if (provider !== "github" && provider !== "gitlab") {
    throw new GitError("no supported hosting provider detected for this remote (GitHub/GitLab only)");
  }
  const command = provider === "github" ? "gh" : "glab";
  const { installed, authenticated } = await toolAvailable(command);
  if (!installed) throw new GitError(`${command} is not installed — install it and run \`${command} auth login\``);
  if (!authenticated) throw new GitError(`${command} is not authenticated — run \`${command} auth login\``);

  const branch = details.branch;
  const existing = await findOpenPr(cwd, provider, branch);
  const baseBranch = await resolvePrBaseBranch(cwd, details);
  if (existing) {
    return {
      status: "opened_existing",
      number: existing.number,
      url: existing.url,
      title: existing.title,
      baseBranch: existing.baseRef || baseBranch,
      headBranch: existing.headRef || branch,
    };
  }

  const bodyFile = join(tmpdir(), `pideck-pr-body-${process.pid}-${randomUUID()}.md`);
  await fsp.writeFile(bodyFile, input.body?.trim() ?? "", { mode: 0o600 });
  try {
    if (provider === "github") {
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "create", "--base", baseBranch, "--head", branch, "--title", title, "--body-file", bodyFile],
        { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
      );
      const url = firstLine(stdout);
      const created = await findOpenPr(cwd, provider, branch);
      return {
        status: "created",
        ...(created ? { number: created.number, url: created.url || url } : { url }),
        title,
        baseBranch,
        headBranch: branch,
      };
    }
    await execFileAsync(
      "glab",
      [
        "api",
        "--method",
        "POST",
        "projects/:fullpath/merge_requests",
        "--raw-field",
        `source_branch=${branch}`,
        "--raw-field",
        `target_branch=${baseBranch}`,
        "--raw-field",
        `title=${title}`,
        "--field",
        `description=@${bodyFile}`,
      ],
      { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const created = await findOpenPr(cwd, provider, branch);
    return {
      status: "created",
      ...(created ? { number: created.number, url: created.url } : {}),
      title,
      baseBranch,
      headBranch: branch,
    };
  } catch (err: any) {
    const message = firstLine(String(err?.stderr ?? err?.message ?? ""));
    throw new GitError(message || `${command} PR creation failed`);
  } finally {
    await fsp.rm(bodyFile, { force: true }).catch(() => {});
  }
}
