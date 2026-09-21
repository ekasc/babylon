// Babylon-owned agent permission system.
//
// This module is intentionally free of any `electron` imports so it can be
// unit-tested in isolation and reused by both the renderer (for previews) and
// the main process (for enforcement). Persistence uses plain `node:fs` against
// a caller-supplied directory so tests can point it at a temp dir.
//
// Two layers:
//   1. Static policy  — explicit allow/deny rules (persistent + session-only).
//   2. Risk review    — when no rule matches, a heuristic classifies the action
//                        as low / high / uncertain risk; "high"/"uncertain" in
//                        `auto` mode and every consequential action in
//                        `supervised` mode is escalated to an interactive ask.
//
// An explicit deny can never be overridden by the risk reviewer or by Full
// Access mode. That invariant is the security backbone of the whole system.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export type ExecutionMode = "supervised" | "auto" | "full_access";

/** Runtime narrowing for IPC payloads (mode arrives as an untyped string). */
export function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === "supervised" || value === "auto" || value === "full_access";
}

/**
 * Policy categories Babylon can distinguish. These are the smallest meaningful
 * units of "consequential action" the agent can take.
 */
export type PolicyCategory =
  | "file_read"
  | "file_write_workspace"
  | "file_write_outside"
  | "shell_command"
  | "shell_destructive"
  | "network_access"
  | "git_commit"
  | "git_push"
  | "package_install"
  | "privileged";

const POLICY_CATEGORIES: readonly PolicyCategory[] = [
  "file_read",
  "file_write_workspace",
  "file_write_outside",
  "shell_command",
  "shell_destructive",
  "network_access",
  "git_commit",
  "git_push",
  "package_install",
  "privileged",
];

/** Runtime narrowing for IPC payloads (the daemon accepts rule categories off
 *  the wire and must not assert them). */
export function isPolicyCategory(value: unknown): value is PolicyCategory {
  return typeof value === "string" && (POLICY_CATEGORIES as readonly string[]).includes(value);
}

export type Risk = "low" | "high" | "uncertain";

export type Decision = "allow" | "deny" | "ask";

export type PermissionMatch = {
  /** Glob (supports `*` and `**`) matched against any action path. */
  pathGlob?: string;
  /** Substring matched against the raw command for shell categories. */
  commandPattern?: string;
};

/** Runtime narrowing for IPC payloads: the daemon parses rules off the wire and
 *  must not assert their shape. */
export function isPermissionMatch(value: unknown): value is PermissionMatch {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.pathGlob === undefined || typeof v.pathGlob === "string") &&
    (v.commandPattern === undefined || typeof v.commandPattern === "string")
  );
}

export type PermissionRule = {
  id: string;
  category: PolicyCategory;
  match?: PermissionMatch;
  decision: "allow" | "deny";
  /** "always" is persisted across restarts; "session" vanishes when the session ends. */
  scope: "always" | "session";
  /** Owning session for session-scoped rules. Concurrent sessions must never
   *  share allow/deny decisions: a rule applies only to its session. */
  sessionId?: string;
  createdAt: number;
  note?: string;
}

export interface AgentAction {
  category: PolicyCategory;
  /** Absolute paths, for file categories. */
  paths?: string[];
  /** Raw command text, for shell categories. */
  command?: string;
  /** Human-readable summary used in approval UI and Activity surfaces. */
  description?: string;
  /** True when the owning repository has uncommitted changes. */
  repoDirty?: boolean;
}

export interface EvalResult {
  decision: Decision;
  risk?: Risk;
  /** Matched rule id, when an explicit rule decided the outcome. */
  ruleId?: string;
  reason?: string;
}

/** Babylon-owned hook used to gate agent tool calls before they execute. */
export interface BabylonPermissionController {
  /** Evaluate an action against static policy + the active execution mode.
   *  The evaluating session id scopes session-only rules to their owner. */
  evaluate(action: AgentAction, sessionId?: string): EvalResult;
  /** Request interactive approval; resolves true to allow, false to deny. */
  requestApproval(action: AgentAction, risk: Risk, sessionId?: string): Promise<boolean>;
  /** Drop session-only rules (called when a session ends; with an id, only
   *  that session's rules are dropped). */
  clearSessionRules(sessionId?: string): void;
  getMode(): ExecutionMode;
  listRules(): PermissionRule[];
}

const ROUTINE_CATEGORIES: ReadonlySet<PolicyCategory> = new Set<PolicyCategory>([
  "file_read",
]);

// Base risk attached to each category before per-action refinement. "uncertain"
// means the risk reviewer cannot make a safe default call, so `auto` mode asks.
const CATEGORY_BASE_RISK: Record<PolicyCategory, Risk> = {
  file_read: "low",
  file_write_workspace: "low",
  file_write_outside: "high",
  shell_command: "uncertain",
  shell_destructive: "high",
  network_access: "high",
  git_commit: "low",
  git_push: "high",
  package_install: "high",
  privileged: "high",
};

// ---------------------------------------------------------------------------
// Command heuristics
// ---------------------------------------------------------------------------

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+-(?:[a-z]*)r[a-z]*f\b/i, // rm -rf / rm -fr
  /\brm\s+-(?:[a-z]*)f[a-z]*r\b/i,
  /git\s+reset\s+--hard\b/i,
  /git\s+clean\s+-/i,
  /git\s+checkout\s+--\s/i,
  /git\s+push\s+(?:-f|--force)\b/i,
  /git\s+branch\s+-D\b/i,
  /\bmkfs\b/i,
  /\bdd\b[^]*\bif=/i,
  />+\s*\/dev\//i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  /\bkill\s+-9\b/i,
  /\bkillall\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\btruncate\s+-s\b/i,
  /:\s*\(\)\s*\{[^}]*\}\s*;/, // fork bomb
];

const PRIVILEGE_PATTERNS: RegExp[] = [
  /\bsudo\b/i,
  /\bdoas\b/i,
  /\bsu\s/i,
  /\brunas\b/i,
  /\bpkexec\b/i,
];

// An external URL: any http(s) host that is not a loopback address.
const EXTERNAL_URL = /\bhttps?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[localhost\])/i;
// Remote-host tooling. A localhost target is treated as internal.
const REMOTE_TOOLS = /\b(?:curl|wget|ssh|scp|rsync|nc|ncat|telnet|ftp|sftp)\b/i;
const LOOPBACK = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[localhost\])\b/i;

const GIT_PUSH = /\bgit\s+push\b/i;
const GIT_COMMIT = /\bgit\s+commit\b/i;

const PACKAGE_INSTALL_PATTERNS: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun|deno)\s+(?:install|add|i\s)\b/i,
  /\bapt(?:-get)?\s+install\b/i,
  /\bbrew\s+install\b/i,
  /\bpip(?:3)?\s+install\b/i,
  /\bcargo\s+add\b/i,
  /\bgo\s+get\b/i,
];

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

export function isPrivileged(command: string): boolean {
  return PRIVILEGE_PATTERNS.some((re) => re.test(command));
}

export function isNetworkCommand(command: string): boolean {
  if (EXTERNAL_URL.test(command)) return true;
  return REMOTE_TOOLS.test(command) && !LOOPBACK.test(command);
}

export function isPackageInstall(command: string): boolean {
  return PACKAGE_INSTALL_PATTERNS.some((re) => re.test(command));
}

/** Map a raw shell command to its most specific policy category. */
export function categorizeShellCommand(command: string): PolicyCategory {
  if (isPackageInstall(command)) return "package_install";
  if (isPrivileged(command)) return "privileged";
  if (isDestructive(command)) return "shell_destructive";
  if (GIT_PUSH.test(command)) return "git_push";
  if (GIT_COMMIT.test(command)) return "git_commit";
  if (isNetworkCommand(command)) return "network_access";
  return "shell_command";
}

/** Categories whose actions originate from shell command text. */
const SHELL_EFFECT_CATEGORIES: ReadonlySet<PolicyCategory> = new Set<PolicyCategory>([
  "package_install",
  "privileged",
  "shell_destructive",
  "git_push",
  "git_commit",
  "network_access",
  "shell_command",
]);

/**
 * Every policy category a shell command touches. A single command string
 * can have several effects (`git push --force` pushes AND destroys;
 * `npm install x && git push` installs AND pushes), but classification
 * picks only one. Compound syntax (`&&`, `||`, `;`, `|`) is split
 * conservatively per segment — over-approximation errs toward deny, which
 * is the safe direction for the deny check below. This is a heuristic
 * classifier, not an execution sandbox.
 */
export function detectShellCategories(command: string): PolicyCategory[] {
  const segments = command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const found: PolicyCategory[] = [];
  const push = (c: PolicyCategory) => {
    if (!found.includes(c)) found.push(c);
  };
  for (const seg of segments.length > 0 ? segments : [command]) {
    if (isPackageInstall(seg)) push("package_install");
    if (isPrivileged(seg)) push("privileged");
    if (isDestructive(seg)) push("shell_destructive");
    if (GIT_PUSH.test(seg)) push("git_push");
    if (GIT_COMMIT.test(seg)) push("git_commit");
    if (isNetworkCommand(seg)) push("network_access");
  }
  if (found.length === 0) push("shell_command");
  return found;
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === undefined) break;
    if (c === "*") {
      // `**` matches across any number of path segments (including slashes).
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 2;
        if (glob[i] === "/") i++;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    // Every other regex metacharacter is escaped so spaces and `?` are literal.
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`^(?:.*/)?${out}$`);
}

export function pathMatchesGlob(glob: string, path: string): boolean {
  const abs = isAbsolute(path) ? path : resolve(path);
  return globToRegExp(glob).test(abs);
}

/** Match a command-pattern rule against a command using word boundaries, so a
 *  deny for `rm` does not catch `charm` and a deny for `git push` matches the
 *  real token. Falls back to a case-insensitive substring on bad input. */
function commandMatches(pattern: string, command: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i").test(command);
  } catch {
    return command.toLowerCase().includes(pattern.toLowerCase());
  }
}

export function matchRule(rule: PermissionRule, action: AgentAction): boolean {
  return matchRuleAs(rule, action, action.category);
}

/** matchRule against one of several detected categories (multi-effect deny). */
function matchRuleAs(rule: PermissionRule, action: AgentAction, category: PolicyCategory): boolean {
  if (rule.category !== category) return false;
  if (!rule.match) return true;
  if (rule.match.pathGlob && action.paths && action.paths.length > 0) {
    return action.paths.some((p) => pathMatchesGlob(rule.match!.pathGlob!, p));
  }
  if (rule.match.commandPattern && action.command) {
    return commandMatches(rule.match.commandPattern, action.command);
  }
  // A rule that declares a matcher but has no corresponding action field
  // cannot match this action.
  return false;
}

// ---------------------------------------------------------------------------
// Risk reviewer
// ---------------------------------------------------------------------------

/**
 * Heuristic risk classification. Always starts from the category's base risk,
 * then escalates when command intent, destructive flags, external network
 * access, privilege escalation, repository state, or the project boundary are
 * involved. It never downgrades an explicitly "high" base.
 */
export function classifyRisk(action: AgentAction): Risk {
  let risk = CATEGORY_BASE_RISK[action.category];

  const command = action.command ?? "";
  if (command) {
    if (isDestructive(command)) risk = "high";
    if (isPrivileged(command)) risk = "high";
    if (isNetworkCommand(command)) risk = "high";
  }

  // A write that leaves the workspace boundary is always high risk.
  if (action.category === "file_write_outside") risk = "high";

  // Destructive work against a dirty repository is especially dangerous.
  if (action.category === "shell_destructive" && action.repoDirty) risk = "high";

  return risk;
}

// ---------------------------------------------------------------------------
// Policy evaluation (pure)
// ---------------------------------------------------------------------------

export interface EvalInput {
  mode: ExecutionMode;
  /** Combined session + persistent rules. */
  rules: PermissionRule[];
  /** Evaluating session: session-scoped rules owned by another session do
   *  not apply. Omitted (legacy/global evaluation) matches all rules. */
  sessionId?: string;
}

function ruleApplies(rule: PermissionRule, sessionId?: string): boolean {
  if (rule.scope !== "session") return true;
  // Session rules require ownership: an ownerless rule only applies to
  // ownerless (legacy/global) evaluations, never across sessions.
  if (!rule.sessionId || !sessionId) return rule.sessionId === sessionId;
  return rule.sessionId === sessionId;
}

export function evaluate(action: AgentAction, input: EvalInput): EvalResult {
  const risk = classifyRisk(action);

  // 1. Explicit deny wins — full stop. Nothing may override it. Shell
  // actions are checked across every detected effect category, so a deny
  // on any effect of the command holds regardless of which single category
  // classification picked.
  const applicable = input.rules.filter((rule) => ruleApplies(rule, input.sessionId));
  const denyCategories = (action: AgentAction): PolicyCategory[] =>
    action.command && SHELL_EFFECT_CATEGORIES.has(action.category)
      ? detectShellCategories(action.command)
      : [action.category];
  for (const rule of applicable) {
    if (rule.decision === "deny" && denyCategories(action).some((c) => matchRuleAs(rule, action, c))) {
      return { decision: "deny", ruleId: rule.id, reason: "Blocked by an explicit deny rule" };
    }
  }

  // 2. Explicit allow.
  for (const rule of applicable) {
    if (rule.decision === "allow" && matchRule(rule, action)) {
      return { decision: "allow", ruleId: rule.id, reason: "Allowed by an explicit allow rule" };
    }
  }

  // 3. No rule — defer to the execution mode.
  switch (input.mode) {
    case "full_access":
      // Deny rules already handled above; everything else is permitted.
      return { decision: "allow", risk, reason: "Full Access mode: no approval required" };
    case "supervised":
      if (ROUTINE_CATEGORIES.has(action.category)) {
        return { decision: "allow", risk, reason: "Supervised mode: routine read allowed" };
      }
      return {
        decision: "ask",
        risk,
        reason: "Supervised mode: approval required for consequential actions",
      };
    case "auto":
    default:
      if (risk === "low") {
        return { decision: "allow", risk, reason: "Auto mode: low-risk action approved" };
      }
      return {
        decision: "ask",
        risk,
        reason:
          risk === "high"
            ? "Auto mode: high-risk action requires approval"
            : "Auto mode: uncertain action requires approval",
      };
  }
}

// ---------------------------------------------------------------------------
// Engine (stateful: mode + rules + persistence)
// ---------------------------------------------------------------------------

export interface PermissionEngineOptions {
  /** Directory where the persistent rule file lives (outside Pi session files). */
  dir: string;
  mode?: ExecutionMode;
}

export class PermissionEngine {
  private readonly filePath: string;
  private mode: ExecutionMode;
  private alwaysRules: PermissionRule[] = [];
  private sessionRules: PermissionRule[] = [];

  constructor(opts: PermissionEngineOptions) {
    this.filePath = resolve(opts.dir, "babylon-permissions.json");
    this.mode = opts.mode ?? "auto";
  }

  /** Load persisted rules + mode. Missing file means defaults. Returns
   *  ok:false when the file exists but is unreadable or corrupt, so callers
   *  can distinguish that from a first run. */
  async load(): Promise<{ ok: boolean; error?: string }> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const parsed = JSON.parse(raw) as { mode?: ExecutionMode; rules?: PermissionRule[] };
      if (typeof parsed.mode === "string") this.mode = parsed.mode;
      this.alwaysRules = Array.isArray(parsed.rules)
        ? parsed.rules.filter((r) => r.scope === "always")
        : [];
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private writeChain: Promise<void> = Promise.resolve();
  private lastPersistError: Error | null = null;

  private async writeFileAtomic(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, JSON.stringify({ mode: this.mode, rules: this.alwaysRules }, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }

  /** Queue a durable write. Errors never reject here; await flush() to observe. */
  private requestPersist(): void {
    this.writeChain = this.writeChain.then(() =>
      this.writeFileAtomic().then(
        () => {
          this.lastPersistError = null;
        },
        (err) => {
          this.lastPersistError = err instanceof Error ? err : new Error(String(err));
        }
      )
    );
  }

  /** Resolve when every write requested so far is durable; throws the latest
   *  write failure once, then clears it. Mutating call sites await this
   *  before acknowledging. */
  async flush(): Promise<void> {
    await this.writeChain;
    const err = this.lastPersistError;
    this.lastPersistError = null;
    if (err) throw err;
  }

  getMode(): ExecutionMode {
    return this.mode;
  }

  setMode(mode: ExecutionMode): void {
    this.mode = mode;
  }

  async setModeAndPersist(mode: ExecutionMode): Promise<void> {
    this.mode = mode;
    this.requestPersist();
    await this.flush();
  }

  /** Drop session-only rules (call when a session ends or is replaced). When a
   *  session id is given, only that session's rules are dropped so concurrent
   *  sessions keep theirs. */
  clearSessionRules(sessionId?: string): void {
    if (sessionId) this.sessionRules = this.sessionRules.filter((r) => r.sessionId !== sessionId);
    else this.sessionRules = [];
  }

  listRules(): PermissionRule[] {
    return [...this.sessionRules, ...this.alwaysRules];
  }

  addRule(input: Omit<PermissionRule, "id" | "createdAt"> & Partial<Pick<PermissionRule, "id" | "createdAt">>): PermissionRule {
    const rule: PermissionRule = {
      id: input.id ?? randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
      category: input.category,
      decision: input.decision,
      scope: input.scope,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      match: input.match,
      note: input.note,
    };
    if (rule.scope === "always") {
      this.alwaysRules.push(rule);
      this.requestPersist();
    } else {
      this.sessionRules.push(rule);
    }
    return rule;
  }

  removeRule(id: string): boolean {
    const beforeAlways = this.alwaysRules.length;
    this.alwaysRules = this.alwaysRules.filter((r) => r.id !== id);
    const wasAlways = this.alwaysRules.length !== beforeAlways;
    const beforeSession = this.sessionRules.length;
    this.sessionRules = this.sessionRules.filter((r) => r.id !== id);
    const wasSession = this.sessionRules.length !== beforeSession;
    if (wasAlways) this.requestPersist();
    return wasAlways || wasSession;
  }

  /** Combined rules: session first so session allow/deny can shadow persistent. */
  private allRules(): PermissionRule[] {
    return [...this.sessionRules, ...this.alwaysRules];
  }

  evaluate(action: AgentAction, sessionId?: string): EvalResult {
    return evaluate(action, { mode: this.mode, rules: this.allRules(), sessionId });
  }

  classifyRisk(action: AgentAction): Risk {
    return classifyRisk(action);
  }
}

/**
 * Apply a resolved approval choice to the engine when the user picks something
 * other than "allow once". Returns the created rule (if any) so callers can
 * echo it back to the UI.
 */
export type ApprovalChoice = "allow_once" | "allow_session" | "allow_always" | "deny";

/** Runtime narrowing for IPC payloads (approval choices arrive from the wire). */
export function isApprovalChoice(value: unknown): value is ApprovalChoice {
  return value === "allow_once" || value === "allow_session" || value === "allow_always" || value === "deny";
}

export function applyApproval(
  engine: PermissionEngine,
  action: AgentAction,
  choice: ApprovalChoice,
  sessionId?: string
): PermissionRule | null {
  switch (choice) {
    case "allow_once":
      return null;
    case "allow_session":
      return engine.addRule({
        category: action.category,
        decision: "allow",
        scope: "session",
        ...(sessionId ? { sessionId } : {}),
        match: action.command ? { commandPattern: action.command } : action.paths ? { pathGlob: action.paths[0] } : undefined,
      });
    case "allow_always":
      return engine.addRule({
        category: action.category,
        decision: "allow",
        scope: "always",
        match: action.command ? { commandPattern: action.command } : action.paths ? { pathGlob: action.paths[0] } : undefined,
      });
    case "deny":
      return engine.addRule({
        category: action.category,
        decision: "deny",
        scope: "session",
        ...(sessionId ? { sessionId } : {}),
        match: action.command ? { commandPattern: action.command } : action.paths ? { pathGlob: action.paths[0] } : undefined,
      });
  }
}
