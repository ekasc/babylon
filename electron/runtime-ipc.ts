import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { IpcHandle } from "./ipc-handle";
import { validateId } from "./process-manager";
import type { RuntimeFacade } from "../src/runtime-facade";
import type { DaemonClient } from "../src/daemon-client";
import type { CheckResult, CompletionContract } from "../src/completion-contracts";

type Handle = IpcHandle;

export function registerRuntimeIpc(
  handle: Handle,
  deps: {
    getRuntime: () => RuntimeFacade;
    daemonOnly: () => DaemonClient | null;
    getWindow: () => BrowserWindow | null;
    getHostReady: () => Promise<void> | null;
  },
): void {
  const { getRuntime, daemonOnly, getWindow, getHostReady } = deps;
  /** Strict identity: every addressed mutator requires a real sessionFile;
   *  no foreground/undefined fallback survives the IPC boundary. */
  const requireSessionFile = (value: unknown): string => {
    if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
      throw new Error("sessionFile is required");
    }
    return value;
  };
  /**
   * Early-boot calls race startHost(): the renderer boots faster than the
   * login-shell import + daemon handshake, so `hostReady` may not even be
   * assigned yet. Wait for the host instead of throwing the named
   * early-startup error. Bounded: a stuck startup still surfaces a real
   * error from getRuntime() rather than hanging the caller forever.
   */
  const awaitHostReady = async (): Promise<void> => {
    const startedAt = Date.now();
    for (;;) {
      const ready = getHostReady();
      if (ready) {
        await ready;
        return;
      }
      if (Date.now() - startedAt > 30_000) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  handle("pideck:get-models", async (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || cwd.length < 1 || cwd.length > 4096) throw new Error("invalid project path");
    return getRuntime().getModels(cwd);
  });
  handle("pideck:warm-project", async (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || cwd.length < 1 || cwd.length > 4096) throw new Error("invalid project path");
    await awaitHostReady();
    return getRuntime().warmProject(cwd);
  });
  handle("pideck:get-commands", async (_e, sessionFile: unknown) => {
    const file = requireSessionFile(sessionFile);
    return getRuntime().getCommands(file);
  });
  handle("pideck:set-model", async (_e, sessionFile: unknown, provider: string, modelId: string) => {
    const file = requireSessionFile(sessionFile);
    return getRuntime().setModel(file, provider, modelId);
  });
  handle("pideck:set-thinking", async (_e, sessionFile: unknown, level: string) => {
    const file = requireSessionFile(sessionFile);
    return getRuntime().setThinking(file, level);
  });
  handle("pideck:get-thinking-levels", async (_e, sessionFile: unknown) => {
    const file = requireSessionFile(sessionFile);
    return getRuntime().getThinkingLevels(file);
  });
  handle("pideck:list-fonts", async () => {
    const { promisify } = await import("node:util");
    const pexec = promisify((await import("node:child_process")).exec);
    const all = new Set<string>();
    all.add("System Default");
    // 1) Try font-list (may be inside asar, may fallback)
    try {
      const { getFonts } = await import("font-list");
      const fonts: string[] = await getFonts({ disableQuoting: true });
      for (const f of fonts) {
        const c = f.replace(/^[\"']|[\"']$/g, "").trim();
        if (c) all.add(c);
      }
    } catch {}
    // 2) system_profiler, most reliable on macOS, includes Miracode
    try {
      const { stdout } = await pexec(`system_profiler SPFontsDataType 2>/dev/null | grep "Family:" | awk -F: '{print $2}' | sort | uniq`, { maxBuffer: 10 * 1024 * 1024 });
      for (const line of String(stdout).split("\n")) {
        const c = line.trim();
        if (c) all.add(c);
      }
    } catch {}
    // 3) Direct font file scan, catches newly installed .ttf/.otf like Miracode.ttf
    try {
      const { readdirSync, existsSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      const { join, basename } = await import("node:path");
      for (const dir of [join(homedir(), "Library/Fonts"), "/Library/Fonts", "/System/Library/Fonts"]) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
          if (/\.(ttf|otf|ttc)$/i.test(f)) {
            const name = basename(f).replace(/\.(ttf|otf|ttc)$/i, "").replace(/[-_]/g, " ").trim();
            if (name) all.add(name);
            // Also add the raw family name without mangling for exact match
            const raw = basename(f).replace(/\.(ttf|otf|ttc)$/i, "");
            if (raw && raw !== name) all.add(raw);
          }
        }
      }
      // Ensure Miracode.ttf is explicitly added if present
      if (existsSync(join(homedir(), "Library/Fonts/Miracode.ttf"))) all.add("Miracode");
    } catch {}
    const cleaned = [...all].sort((a, b) => a.localeCompare(b));
    // Ensure System Default is first
    const sorted = ["System Default", ...cleaned.filter((f) => f !== "System Default")];
    return sorted;
  });
  handle("pideck:get-settings", async () => {
    await awaitHostReady();
    return getRuntime().getSettings();
  });
  handle("pideck:set-settings", (_e, patch: unknown) => getRuntime().setSettings(patch));
  handle("pideck:set-session-name", async (_e, sessionFile: unknown, name: string) => {
    const file = requireSessionFile(sessionFile);
    if (typeof name !== "string" || name.length > 500) throw new Error("invalid session name");
    return getRuntime().setSessionName(file, name);
  });
  handle("pideck:compact", async (_e, sessionFile: unknown, customInstructions?: unknown) => {
    const file = requireSessionFile(sessionFile);
    if (customInstructions !== undefined && typeof customInstructions !== "string") throw new Error("invalid compaction instructions");
    return getRuntime().compact(file, customInstructions);
  });

  // Branching / worktrees
  handle("pideck:get-tree", async (_e, sessionFile: unknown) => {
    const file = requireSessionFile(sessionFile);
    return getRuntime().getTree(file);
  });
  handle("pideck:get-history", async (_e, sessionFile: unknown) => {
    const file = requireSessionFile(sessionFile);
    return getRuntime().getHistory(file);
  });
  handle("pideck:turn-changes", async (_e, sessionFile: unknown, entryId: unknown) => {
    const file = requireSessionFile(sessionFile);
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    return getRuntime().getTurnChanges(file, entryId);
  });
  handle("pideck:turn-file-diff", async (_e, sessionFile: unknown, entryId: unknown, path: unknown) => {
    const file = requireSessionFile(sessionFile);
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    if (typeof path !== "string" || path.length < 1 || path.length > 4096) throw new Error("invalid file path");
    return getRuntime().getTurnFileDiff(file, entryId, path);
  });
  handle("pideck:rollback:prepare", async (_e, sessionFile: unknown, entryId: string) => {
    const file = requireSessionFile(sessionFile);
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    return getRuntime().prepareRollback(file, entryId);
  });
  handle("pideck:rollback:commit", (_e, planId: string) => {
    if (typeof planId !== "string" || !/^[0-9a-f-]{36}$/i.test(planId)) throw new Error("invalid rollback plan ID");
    return getRuntime().commitRollback(planId);
  });
  handle("pideck:rollback:undo", async (_e, sessionFile: unknown) => {
    const file = requireSessionFile(sessionFile);
    return getRuntime().undoRollback(file);
  });
  handle("pideck:get-fork-messages", async (_e, sessionFile: unknown) => {
    const file = requireSessionFile(sessionFile);
    return getRuntime().getForkMessages(file);
  });
  handle("pideck:fork", async (_e, sessionFile: unknown, entryId: string) => {
    const file = requireSessionFile(sessionFile);
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    return getRuntime().fork(file, entryId);
  });
  handle("pideck:clone", async (_e, sessionFile: unknown) => {
    const file = requireSessionFile(sessionFile);
    return getRuntime().clone(file);
  });
  handle("pideck:task-list", async () => getRuntime().taskList());
  handle("pideck:task-get", async (_e, id: unknown) => {
    if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new Error("invalid task id");
    return getRuntime().taskGet(id);
  });
  handle("pideck:task-set-contract", async (_e, taskId: unknown, contract: unknown) => {
    const id = validateId(taskId);
    if (!contract || typeof (contract as CompletionContract).id !== "string") throw new Error("invalid contract");
    const c = contract as CompletionContract;
    await getRuntime().contractSet(c);
    // Also set contractId on task via facade
    const task = await getRuntime().taskGet(id);
    if (task) await getRuntime().taskUpdate(id, { contractId: c.id });
    return c;
  });
  handle("pideck:task-complete", async (_e, taskId: unknown, results: unknown) => {
    const id = validateId(taskId);
    const runtime = getRuntime();
    const task = await runtime.taskGet(id);
    if (!task) throw new Error("unknown task");
    const checkResults = Array.isArray(results) ? (results as CheckResult[]) : [];
    const hooks = await runtime.hooksList();
    const registry = { hooks: Object.fromEntries(hooks.map((h) => [h.id, h])), order: hooks.map((h) => h.id) } as import("../src/hooks").HookRegistry;
    const { dispatchHooks } = await import("../src/hook-dispatcher");
    const hookOutcome = await dispatchHooks(
      registry,
      "before_stop",
      { sessionId: task.sessionId ?? "", taskId: id },
      async (def) => {
        if (def.action === "block") return { block: { reason: `Blocked by hook ${def.id}` } };
        return {};
      }
    );
    if (hookOutcome.blocked) {
      await runtime.attentionRaise({
        id: `hook-${id}-${Date.now()}`,
        type: "blocked_task",
        title: `Task blocked by hook: ${task.title}`,
        detail: hookOutcome.blocked.result.block?.reason ?? "blocked",
        source: id,
        createdAt: Date.now(),
        resolved: false,
      });
      return { blocked: true, reason: hookOutcome.blocked.result.block?.reason, hookId: hookOutcome.blocked.id };
    }
    // The daemon owns the contract gate when enabled: it evaluates the
    // persisted contract and raises failed_task attention atomically, so the
    // gate survives client restarts. The local runtime mirrors that logic.
    const outcome = await runtime.taskComplete(id, checkResults);
    if (outcome.blocked && daemonOnly()) {
      // Surface the daemon-raised failed_task item on the attention channel
      // like any attention.raised event.
      daemonOnly()
        ?.request("state.get", {})
        .then((res) => {
          const runtimeState = (res.payload as { runtime?: { attention?: unknown } })?.runtime;
          getWindow()?.webContents.send("pideck:attention-update", runtimeState?.attention ?? { items: {} });
        })
        .catch(() => {});
    }
    return outcome;
  });
  handle("pideck:hooks-list", async () => getRuntime().hooksList());
  handle("pideck:hooks-register", async (_e, hook: unknown) => {
    if (!hook || typeof (hook as { id?: unknown }).id !== "string") throw new Error("invalid hook");
    await getRuntime().hooksRegister(hook as import("../src/hooks").HookDefinition);
    return getRuntime().hooksList();
  });
  handle("pideck:hooks-remove", async (_e, id: unknown) => {
    await getRuntime().hooksRemove(validateId(id));
    return getRuntime().hooksList();
  });
  handle("pideck:contracts-list", async () => getRuntime().contractsList());
  handle("pideck:contracts-get", async (_e, id: unknown) => getRuntime().contractGet(validateId(id as string)));
  handle("pideck:attention-list", async () => getRuntime().attentionList());
  handle("pideck:attention-resolve", async (_e, id: unknown) => {
    await getRuntime().attentionResolve(validateId(id));
    return getRuntime().attentionList();
  });
}
