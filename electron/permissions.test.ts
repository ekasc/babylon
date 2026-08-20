import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PermissionEngine,
  applyApproval,
  categorizeShellCommand,
  classifyRisk,
  evaluate,
  isDestructive,
  isNetworkCommand,
  isPackageInstall,
  isPrivileged,
  matchRule,
  pathMatchesGlob,
  type AgentAction,
  type PermissionRule,
} from "./permissions";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "babylon-perm-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const fileWriteWs: AgentAction = {
  category: "file_write_workspace",
  paths: ["/project/src/app.ts"],
  description: "edit app.ts",
};
const fileWriteOutside: AgentAction = {
  category: "file_write_outside",
  paths: ["/etc/hosts"],
};
const shellRisky: AgentAction = {
  category: "shell_command",
  command: "npm run build",
};
const pushAction: AgentAction = {
  category: "git_push",
};

describe("command heuristics", () => {
  it("detects destructive commands", () => {
    expect(isDestructive("rm -rf dist")).toBe(true);
    expect(isDestructive("git reset --hard")).toBe(true);
    expect(isDestructive("git push --force origin main")).toBe(true);
    expect(isDestructive("ls -la")).toBe(false);
  });

  it("detects privileged commands", () => {
    expect(isPrivileged("sudo rm file")).toBe(true);
    expect(isPrivileged("doas reboot")).toBe(true);
    expect(isPrivileged("echo hi")).toBe(false);
  });

  it("detects network commands", () => {
    expect(isNetworkCommand("curl https://example.com")).toBe(true);
    expect(isNetworkCommand("ssh user@host")).toBe(true);
    expect(isNetworkCommand("curl http://localhost:3000")).toBe(false);
  });

  it("detects package installs", () => {
    expect(isPackageInstall("npm install lodash")).toBe(true);
    expect(isPackageInstall("pnpm add react")).toBe(true);
    expect(isPackageInstall("brew install git")).toBe(true);
    expect(isPackageInstall("ls")).toBe(false);
  });

  it("categorizes shell commands to most specific category", () => {
    expect(categorizeShellCommand("rm -rf node_modules")).toBe("shell_destructive");
    expect(categorizeShellCommand("sudo reboot")).toBe("privileged");
    expect(categorizeShellCommand("npm install")).toBe("package_install");
    expect(categorizeShellCommand("curl https://x.com")).toBe("network_access");
    expect(categorizeShellCommand("ls -la")).toBe("shell_command");
  });
});

describe("rule matching", () => {
  const allowWrite: PermissionRule = {
    id: "r1",
    category: "file_write_workspace",
    decision: "allow",
    scope: "always",
    createdAt: 0,
  };

  it("matches by category when no matcher is present", () => {
    expect(matchRule(allowWrite, fileWriteWs)).toBe(true);
    expect(matchRule(allowWrite, shellRisky)).toBe(false);
  });

  it("matches path globs", () => {
    const rule: PermissionRule = {
      ...allowWrite,
      match: { pathGlob: "**/src/**" },
    };
    expect(matchRule(rule, fileWriteWs)).toBe(true);
    expect(matchRule(rule, { ...fileWriteWs, paths: ["/project/test.txt"] })).toBe(false);
  });

  it("matches commands on word boundaries, not substrings", () => {
    const rule: PermissionRule = {
      id: "r2",
      category: "shell_command",
      decision: "allow",
      scope: "always",
      createdAt: 0,
      match: { commandPattern: "npm run" },
    };
    expect(matchRule(rule, shellRisky)).toBe(true);
    expect(matchRule(rule, { ...shellRisky, command: "ls" })).toBe(false);
    // "rm" must not match "charm", and "git push" matches the real token.
    const rmRule: PermissionRule = { ...rule, match: { commandPattern: "rm" } };
    expect(matchRule(rmRule, { category: "shell_command", command: "charm file" })).toBe(false);
    expect(matchRule(rmRule, { category: "shell_command", command: "rm -rf x" })).toBe(true);
  });

  it("pathMatchesGlob treats spaces as literal and ? as a single segment", () => {
    // A space in the glob must stay literal, not become a wildcard.
    expect(pathMatchesGlob("src/a b.ts", "/project/src/a b.ts")).toBe(true);
    expect(pathMatchesGlob("src/a b.ts", "/project/src/axb.ts")).toBe(false);
    // `?` matches exactly one non-slash character, not a whole name.
    expect(pathMatchesGlob("**/a?.ts", "/project/src/a1.ts")).toBe(true);
    expect(pathMatchesGlob("**/a?.ts", "/project/src/a12.ts")).toBe(false);
    // `**` crosses directory boundaries.
    expect(pathMatchesGlob("**/deep.ts", "/project/src/x/y/deep.ts")).toBe(true);
  });
});

describe("risk classification", () => {
  it("returns category base risk", () => {
    expect(classifyRisk(fileWriteWs)).toBe("low");
    expect(classifyRisk(fileWriteOutside)).toBe("high");
    expect(classifyRisk(pushAction)).toBe("high");
    expect(classifyRisk(shellRisky)).toBe("uncertain");
  });

  it("escalates destructive shell to high", () => {
    expect(classifyRisk({ category: "shell_command", command: "rm -rf dist" })).toBe("high");
  });

  it("escalates privileged and network commands to high", () => {
    expect(classifyRisk({ category: "shell_command", command: "sudo ls" })).toBe("high");
    expect(classifyRisk({ category: "shell_command", command: "curl https://x.com" })).toBe("high");
  });
});

describe("evaluate — static policy precedence", () => {
  it("explicit deny beats explicit allow and mode", () => {
    const rules: PermissionRule[] = [
      { id: "a", category: "git_push", decision: "allow", scope: "always", createdAt: 0 },
      { id: "d", category: "git_push", decision: "deny", scope: "always", createdAt: 0 },
    ];
    const r = evaluate(pushAction, { mode: "full_access", rules });
    expect(r.decision).toBe("deny");
    expect(r.ruleId).toBe("d");
  });

  it("explicit allow wins over asking in supervised mode", () => {
    const rules: PermissionRule[] = [
      { id: "a", category: "file_write_workspace", decision: "allow", scope: "always", createdAt: 0 },
    ];
    const r = evaluate(fileWriteWs, { mode: "supervised", rules });
    expect(r.decision).toBe("allow");
    expect(r.ruleId).toBe("a");
  });

  it("deny cannot be overridden by full access", () => {
    const rules: PermissionRule[] = [
      { id: "d", category: "network_access", decision: "deny", scope: "always", createdAt: 0 },
    ];
    const r = evaluate(
      { category: "network_access", command: "curl https://x.com" },
      { mode: "full_access", rules }
    );
    expect(r.decision).toBe("deny");
  });
});

describe("evaluate — execution modes", () => {
  it("full access allows everything not explicitly denied", () => {
    expect(evaluate(shellRisky, { mode: "full_access", rules: [] }).decision).toBe("allow");
    expect(evaluate(pushAction, { mode: "full_access", rules: [] }).decision).toBe("allow");
  });

  it("supervised asks for consequential actions but allows routine reads", () => {
    expect(evaluate(fileWriteWs, { mode: "supervised", rules: [] }).decision).toBe("ask");
    expect(evaluate(pushAction, { mode: "supervised", rules: [] }).decision).toBe("ask");
    expect(
      evaluate({ category: "file_read", paths: ["/project/a.ts"] }, { mode: "supervised", rules: [] }).decision
    ).toBe("allow");
  });

  it("auto allows low risk and asks for high/uncertain", () => {
    expect(evaluate(fileWriteWs, { mode: "auto", rules: [] }).decision).toBe("allow");
    expect(evaluate(pushAction, { mode: "auto", rules: [] }).decision).toBe("ask");
    expect(evaluate(shellRisky, { mode: "auto", rules: [] }).decision).toBe("ask");
  });
});

describe("PermissionEngine persistence + scope", () => {
  it("persists always rules and mode across reloads", async () => {
    const engine = new PermissionEngine({ dir: tmp, mode: "supervised" });
    await engine.load();
    engine.addRule({ category: "file_write_workspace", decision: "allow", scope: "always" });
    await engine.setModeAndPersist("full_access");

    const reloaded = new PermissionEngine({ dir: tmp });
    await reloaded.load();
    expect(reloaded.getMode()).toBe("full_access");
    expect(reloaded.listRules()).toHaveLength(1);
    expect(reloaded.evaluate(fileWriteWs).decision).toBe("allow");
  });

  it("session rules are not persisted and clearSessionRules drops them", async () => {
    const engine = new PermissionEngine({ dir: tmp });
    await engine.load();
    const sessionRule = engine.addRule({ category: "git_push", decision: "allow", scope: "session" });
    expect(engine.listRules()).toHaveLength(1);
    expect(engine.evaluate(pushAction).decision).toBe("allow");

    engine.clearSessionRules();
    expect(engine.listRules()).toHaveLength(0);
    expect(engine.evaluate(pushAction).decision).toBe("ask");

    // Reloading from disk must not bring the session rule back.
    const reloaded = new PermissionEngine({ dir: tmp });
    await reloaded.load();
    expect(reloaded.listRules()).toHaveLength(0);
    expect(sessionRule.scope).toBe("session");
  });

  it("removeRule drops both scopes and persists for always", async () => {
    const engine = new PermissionEngine({ dir: tmp });
    await engine.load();
    const r = engine.addRule({ category: "git_push", decision: "deny", scope: "always" });
    expect(engine.removeRule(r.id)).toBe(true);
    expect(engine.listRules()).toHaveLength(0);

    const reloaded = new PermissionEngine({ dir: tmp });
    await reloaded.load();
    expect(reloaded.listRules()).toHaveLength(0);
  });

  it("removeRule returns true for session-only rules too", async () => {
    const engine = new PermissionEngine({ dir: tmp });
    await engine.load();
    const session = engine.addRule({ category: "git_push", decision: "allow", scope: "session" });
    expect(engine.removeRule(session.id)).toBe(true);
    expect(engine.listRules()).toHaveLength(0);
  });
});

describe("applyApproval", () => {
  it("allow_once creates no rule", async () => {
    const engine = new PermissionEngine({ dir: tmp });
    await engine.load();
    const rule = applyApproval(engine, shellRisky, "allow_once");
    expect(rule).toBeNull();
    expect(engine.listRules()).toHaveLength(0);
  });

  it("allow_session / allow_always / deny create scoped rules", async () => {
    const engine = new PermissionEngine({ dir: tmp });
    await engine.load();

    const session = applyApproval(engine, shellRisky, "allow_session");
    expect(session?.scope).toBe("session");
    expect(engine.evaluate(shellRisky).decision).toBe("allow");

    const always = applyApproval(engine, pushAction, "allow_always");
    expect(always?.scope).toBe("always");
    expect(engine.evaluate(pushAction).decision).toBe("allow");

    const deny = applyApproval(engine, fileWriteOutside, "deny");
    expect(deny?.decision).toBe("deny");
    expect(engine.evaluate(fileWriteOutside).decision).toBe("deny");
  });
});
