import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapToolToAction, resolveInsideWorkspace } from "./permission-agent";

const CWD = "/project";

describe("resolveInsideWorkspace", () => {
  it("treats nested paths as inside and siblings as outside", () => {
    expect(resolveInsideWorkspace("/project/src/a.ts", CWD)).toBe(true);
    expect(resolveInsideWorkspace("src/a.ts", CWD)).toBe(true);
    expect(resolveInsideWorkspace("/other/a.ts", CWD)).toBe(false);
    expect(resolveInsideWorkspace("/project../a.ts", CWD)).toBe(false);
  });

  it("resolves symlinks so a workspace link cannot downgrade an OOW write", () => {
    const base = mkdtempSync(join(tmpdir(), "babylon-sym-"));
    try {
      // /workspace is a real dir; /outside is a real dir OUTSIDE it.
      const workspace = join(base, "workspace");
      const outside = join(base, "outside");
      mkdirSync(workspace);
      mkdirSync(outside);
      // Simulate a symlink at workspace/escape -> ../outside.
      const escapeLink = join(workspace, "escape");
      symlinkSync(outside, escapeLink);
      // Writing through the symlink must be treated as OUTSIDE the workspace.
      expect(resolveInsideWorkspace(join(escapeLink, "secret"), workspace)).toBe(false);
      // The real workspace path is still inside.
      expect(resolveInsideWorkspace(join(workspace, "a.ts"), workspace)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("mapToolToAction", () => {
  it("maps shell commands to their specific category", () => {
    expect(mapToolToAction("bash", { command: "rm -rf dist" }, CWD)?.category).toBe("shell_destructive");
    expect(mapToolToAction("bash", { command: "sudo ls" }, CWD)?.category).toBe("privileged");
    expect(mapToolToAction("bash", { command: "npm install lodash" }, CWD)?.category).toBe("package_install");
    expect(mapToolToAction("bash", { command: "curl https://x.com" }, CWD)?.category).toBe("network_access");
    expect(mapToolToAction("bash", { command: "ls -la" }, CWD)?.category).toBe("shell_command");
  });

  it("maps reads", () => {
    const a = mapToolToAction("read", { path: "src/a.ts" }, CWD);
    expect(a?.category).toBe("file_read");
    expect(a?.paths?.[0]).toBe("/project/src/a.ts");
  });

  it("maps writes inside vs outside the workspace", () => {
    expect(mapToolToAction("write", { path: "src/a.ts" }, CWD)?.category).toBe("file_write_workspace");
    expect(mapToolToAction("edit", { path: "/etc/hosts" }, CWD)?.category).toBe("file_write_outside");
  });

  it("returns null for unpoliced tools", () => {
    expect(mapToolToAction("todo_write", {}, CWD)).toBeNull();
    expect(mapToolToAction("unknown_tool", {}, CWD)).toBeNull();
  });

  it("falls back to shell when a command arg is present on an unknown tool", () => {
    expect(mapToolToAction("custom_runner", { command: "git push" }, CWD)?.category).toBe("git_push");
  });
});
