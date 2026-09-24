import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createOwnerCwdResolver, registerWorktreeIpc } from "./worktree-ipc";
import { rewriteSessionHeader } from "./session-files";
import type { IpcHandle } from "./ipc-handle";
import type { RuntimeFacade } from "../src/runtime-facade";
import type { TaskManager } from "./task-manager";
import type { ProcessManager } from "./process-manager";
import type { DaemonClient } from "../src/daemon-client";

vi.mock("electron", () => ({ shell: {}, app: { getPath: () => tmpdir() } }));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-wt-${tag}-`));
  roots.push(cwd);
  return cwd;
}

async function makeSessionFile(cwd: string): Promise<string> {
  const sm = SessionManager.create(cwd);
  const file = sm.getSessionFile();
  if (!file) throw new Error("no canonical session file");
  // SessionManager only flushes to disk once an ASSISTANT message exists, so
  // write a complete turn: these tests need real files with real headers.
  const when = Date.now();
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "seed" }], timestamp: when });
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "seeded" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: when + 1,
  });
  return file;
}

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown;

interface RuntimeCall {
  method: string;
  args: unknown[];
}

/** A worktree harness whose runtime records every addressed mutation, so the
 *  tests can assert the EXACT project each call used. */
function harness(options: {
  ownerCwdFor: (file: string) => Promise<string | null>;
  focusedCwd: string;
  daemon?: boolean;
  cloneFile?: string | null;
  relocateThrows?: boolean;
  clientRequest?: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const calls: RuntimeCall[] = [];
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (method === "clone") return { cancelled: false, sessionFile: options.cloneFile ?? null };
    if (method === "getState") return { sessionFile: args[0] as string, sessionId: `sid-${String(args[0])}` };
    if (method === "relocateExecution" && options.relocateThrows) throw new Error("relocate failed");
    if (method === "clone") return { cancelled: false };
    return null;
  };
  const getRuntime = () =>
    ({
      getState: record("getState"),
      clone: record("clone"),
      setSessionName: record("setSessionName"),
      prompt: record("prompt"),
      relocateExecution: record("relocateExecution"),
      executionActivate: record("executionActivate"),
    }) as unknown as RuntimeFacade;

  const handlers = new Map<string, Handler>();
  const handle = ((channel: string, fn: Handler) => handlers.set(channel, fn)) as IpcHandle;
  let focus = options.focusedCwd;

  const client = {
    request: vi.fn(async (type: string, payload: Record<string, unknown>) => ({
      payload: options.clientRequest ? await options.clientRequest(type, payload) : { id: "task-1" },
    })),
  } as unknown as DaemonClient;

  registerWorktreeIpc(handle, {
    getRuntime,
    ownerCwdFor: options.ownerCwdFor,
    isDaemonOwned: () => options.daemon ?? false,
    daemonOnly: () => (options.daemon ? client : null),
    requireDaemonClient: () => client,
    daemonTaskBySessionFile: async () => undefined,
    daemonTaskBySessionFileStrict: async () => undefined,
    taskManager: {
      register: (input: unknown) => ({ id: "task-1", ...(input as object) }),
      // SYNC, like the real manager: an async mock would be a truthy Promise
      // and the handler would take the task branch.
      findBySessionFile: () => undefined,
      exit: vi.fn(async () => true),
      setStatus: vi.fn(),
      get: () => undefined,
    } as unknown as TaskManager,
    processManager: { spawn: vi.fn(), killByOwner: vi.fn(async () => undefined) } as unknown as ProcessManager,
    getFocusedCwd: () => focus,
  });

  return {
    calls,
    client,
    setFocus: (next: string) => {
      focus = next;
    },
    invoke: async (channel: string, ...args: unknown[]) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({}, ...args);
    },
  };
}

const callsTo = (calls: RuntimeCall[], method: string) => calls.filter((c) => c.method === method);

describe("owner-project resolver", () => {
  it("answers from the runtime registry and never from focus", async () => {
    const focused = await makeProject("resolver-focus-only");
    const executionCwdFor = vi.fn(async (file: string) => (file === "/owner.jsonl" ? "/p1" : null));
    const resolve = createOwnerCwdResolver(() => ({ executionCwdFor }) as unknown as RuntimeFacade);
    expect(await resolve("/owner.jsonl")).toBe("/p1");
    expect(await resolve("/historical.jsonl")).toBeNull();
    // Focus is not even reachable from here, and nothing is ever substituted.
    expect(JSON.stringify(await resolve("/other.jsonl"))).not.toContain(focused);
  });

  it("returns null when the runtime cannot answer — a failure is never a fallback", async () => {
    const executionCwdFor = vi.fn(async () => {
      throw new Error("daemon reconnecting");
    });
    const resolve = createOwnerCwdResolver(() => ({ executionCwdFor }) as unknown as RuntimeFacade);
    await expect(resolve("/owner.jsonl")).resolves.toBeNull();
  });
});

describe("worktree-create identifies its project by execution ownership", () => {
  it("uses the addressed owner's project, never the focused one", async () => {
    const p1 = await makeProject("own-p1");
    const p2 = await makeProject("focus-p2");
    const source = await makeSessionFile(p1);
    const clone = await makeSessionFile(p1);
    const h = harness({
      // A owns P1 while the UI is focused on P2.
      ownerCwdFor: async (file) => (file === source ? p1 : null),
      focusedCwd: p2,
      daemon: true,
      cloneFile: clone,
    });

    const result = (await h.invoke("pideck:worktree-create", { name: "exp one" }, source)) as {
      sessionFile: string;
      cwd: string;
    };

    // Navigation identity is the clone, in the OWNING project.
    expect(result.sessionFile).toBe(clone);
    expect(result.cwd).toBe(p1);
    // No mutation ever mentions the focused project.
    expect(JSON.stringify(h.calls)).not.toContain(p2);
  });

  it("refuses a session that owns no project, before cloning anything", async () => {
    const p1 = await makeProject("nonowner-p1");
    const focus = await makeProject("nonowner-focus");
    const historical = await makeSessionFile(p1);
    const h = harness({ ownerCwdFor: async () => null, focusedCwd: focus });

    await expect(h.invoke("pideck:worktree-create", { name: "exp" }, historical)).rejects.toThrow(
      /not this host's execution session/
    );
    // Nothing was cloned: the refusal is before any mutation.
    expect(callsTo(h.calls, "clone")).toHaveLength(0);
  });

  it("never substitutes the focused project when the resolver fails", async () => {
    const p1 = await makeProject("resolver-p1");
    const focus = await makeProject("resolver-focus");
    const source = await makeSessionFile(p1);
    const h = harness({
      // Daemon reconnecting: the resolver throws.
      ownerCwdFor: async () => {
        throw new Error("daemon reconnecting");
      },
      focusedCwd: focus,
      daemon: true,
    });

    await expect(h.invoke("pideck:worktree-create", { name: "exp" }, source)).rejects.toThrow(/daemon reconnecting/);
    expect(callsTo(h.calls, "clone")).toHaveLength(0);
    expect(JSON.stringify(h.calls)).not.toContain(focus);
  });

  it("a failure after cloning restores the ORIGINAL owner before destroying anything", async () => {
    const p1 = await makeProject("rollback-p1");
    const focus = await makeProject("rollback-focus");
    const source = await makeSessionFile(p1);
    const clone = await makeSessionFile(p1);
    const h = harness({ ownerCwdFor: async () => p1, focusedCwd: focus, cloneFile: clone });

    // The failure lands AFTER the clone exists (git worktree setup on a
    // non-repo project), which is exactly the window the transaction covers.
    await expect(
      h.invoke("pideck:worktree-create", { name: "exp", useGit: true }, source)
    ).rejects.toThrow(/not a git repository/);

    const activations = callsTo(h.calls, "executionActivate");
    // The original session is handed back in ITS project, and the focused
    // project is nowhere in the mutation identity.
    expect(activations).toHaveLength(1);
    expect(activations[0]?.args).toEqual([p1, source]);
    expect(JSON.stringify(h.calls)).not.toContain(focus);
  });
});

describe("worktree-create relocates ownership into the worktree", () => {
  it("relocates the CLONE from the owning project into the worktree cwd", async () => {
    // The one path that moves execution ownership: the clone owns the project
    // right after cloning, and the git worktree RELOCATES it under the new cwd.
    const repo = await makeProject("git-repo");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "seed\n");
    // A commit, so rev-parse --abbrev-ref HEAD resolves and the repo is
    // recognised as a repo with a branch.
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "init"], { cwd: repo });

    const source = await makeSessionFile(repo);
    const clone = await makeSessionFile(repo);
    const h = harness({ ownerCwdFor: async () => repo, focusedCwd: repo, cloneFile: clone });

    const result = (await h.invoke(
      "pideck:worktree-create",
      { name: "exp", useGit: true },
      source
    )) as { cwd: string; sessionFile: string; gitWorktree: { path: string } | null };

    expect(result.gitWorktree).not.toBeNull();
    expect(result.cwd).toBe(result.gitWorktree?.path);
    const relocations = callsTo(h.calls, "relocateExecution");
    expect(relocations).toHaveLength(1);
    expect(relocations[0]?.args).toEqual([clone, repo, result.gitWorktree?.path]);
  }, 60_000);
});

describe("worktree-exit hands the project back to the original session", () => {
  it("reactivates the original session in ITS project and returns that identity", async () => {
    const p1 = await makeProject("exit-p1");
    const focus = await makeProject("exit-focus");
    const original = await makeSessionFile(p1);
    const worktreeFile = await makeSessionFile(p1);
    // A worktree session header names the project it was branched from and the
    // project it now lives in.
    await rewriteSessionHeader(worktreeFile, { parentSession: original, cwd: p1 });
    const h = harness({ ownerCwdFor: async (f) => (f === original ? p1 : null), focusedCwd: focus });

    const result = (await h.invoke("pideck:worktree-exit", { keep: false }, worktreeFile)) as {
      sessionFile: string;
      cwd: string;
      originalPath: string;
    };

    const activations = callsTo(h.calls, "executionActivate");
    expect(activations).toHaveLength(1);
    expect(activations[0]?.args).toEqual([p1, original]);
    expect(result.sessionFile).toBe(original);
    expect(result.cwd).toBe(p1);
    // The UI's focused project is never substituted.
    expect(JSON.stringify(h.calls)).not.toContain(focus);
  });
});

describe("worktree mutations ignore a mid-operation focus change", () => {
  it("uses the owning project even when the UI switches Spaces during the awaits", async () => {
    const p1 = await makeProject("race-p1");
    const p2 = await makeProject("race-p2");
    const source = await makeSessionFile(p1);
    const clone = await makeSessionFile(p1);
    const h = harness({
      ownerCwdFor: async (file) => {
        // The user changes Spaces while the clone is in flight.
        if (file === source) {
          h.setFocus(p2);
          return p1;
        }
        return null;
      },
      focusedCwd: p1,
      cloneFile: clone,
    });

    const result = (await h.invoke("pideck:worktree-create", { name: "exp" }, source)) as { cwd: string };
    expect(result.cwd).toBe(p1);
    expect(JSON.stringify(h.calls)).not.toContain(p2);
  });
});
