// Maps a Pi agent tool call to a Babylon permission action.
//
// Babylon enforces permissions by intercepting Pi's `beforeToolCall` hook. That
// hook gives us the tool name and its (validated) arguments; from those we
// derive the policy category and the affected paths / command so the engine can
// evaluate static policy and risk. This module is pure and dependency-free so
// it can be unit-tested without Electron or a running agent.

import { isAbsolute, resolve } from "node:path";
import { categorizeShellCommand, type AgentAction } from "./permissions";

/** True when `path` resolves inside the workspace root `cwd`. */
export function resolveInsideWorkspace(path: string, cwd: string): boolean {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const norm = abs.endsWith("/") ? abs : `${abs}/`;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return norm.startsWith(base);
}

/**
 * Translate a Pi tool call into a Babylon action, or null when the tool is not
 * something Babylon polices (pure read-only navigation, internal bookkeeping).
 */
export function mapToolToAction(toolName: string, args: unknown, cwd: string): AgentAction | null {
  const name = (toolName || "").toLowerCase();
  const a = (args ?? {}) as Record<string, unknown>;

  const command =
    typeof a.command === "string" ? a.command : typeof a.cmd === "string" ? a.cmd : undefined;

  // Shell execution is the highest-value thing to police: destructive flags,
  // privilege escalation, and external network access all live here.
  if (command) {
    const category = categorizeShellCommand(command);
    return { category, command, description: `Run: ${command}` };
  }

  // Read-only file tools.
  if (name === "read" || name === "glob" || name === "grep" || name === "ls" || name === "cat") {
    const path = typeof a.path === "string" ? a.path : undefined;
    return {
      category: "file_read",
      paths: path ? [resolve(cwd, path)] : undefined,
      description: `Read ${path ?? ""}`.trim(),
    };
  }

  // File mutating tools.
  if (name === "write" || name === "edit" || name === "multi_edit" || name === "create_file") {
    const path = typeof a.path === "string" ? a.path : undefined;
    if (!path) return null;
    const abs = isAbsolute(path) ? path : resolve(cwd, path);
    const category = resolveInsideWorkspace(abs, cwd) ? "file_write_workspace" : "file_write_outside";
    return { category, paths: [abs], description: `Write ${abs}` };
  }

  return null;
}
