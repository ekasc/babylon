import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { validateId } from "./process-manager";
import type { RuntimeFacade } from "../src/runtime-facade";
import type { DaemonClient } from "../src/daemon-client";
import type { CheckResult, CompletionContract } from "../src/completion-contracts";

type Handle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
) => void;

export function registerRuntimeIpc(
  handle: Handle,
  deps: {
    getRuntime: () => RuntimeFacade;
    daemonOnly: () => DaemonClient | null;
    getWindow: () => BrowserWindow | null;
  },
): void {
  const { getRuntime, daemonOnly, getWindow } = deps;
  handle("pideck:get-models", () => getRuntime().getModels());
  handle("pideck:warm-project", (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || cwd.length < 1 || cwd.length > 4096) throw new Error("invalid project path");
    return getRuntime().warmProject(cwd);
  });
  handle("pideck:get-commands", () => getRuntime().getCommands());
  handle("pideck:set-model", (_e, provider: string, modelId: string) =>
    getRuntime().setModel(provider, modelId)
  );
  handle("pideck:set-thinking", (_e, level: string) => getRuntime().setThinking(level));
  handle("pideck:get-thinking-levels", () => getRuntime().getThinkingLevels());
  handle("pideck:list-fonts", async () => {
    const { promisify } = await import("node:util");
    const pexec = promisify((await import("node:child_process")).exec);
    const all = new Set<string>();
    all.add("System Default");
    // 1) Try font-list (may be inside asar, may fallback)
    try {
      const { getFonts } = await import("font-list");
      const fonts: string[] = await (getFonts as any)({ disableQuoting: true });
      for (const f of fonts) {
        const c = f.replace(/^[\"']|[\"']$/g, "").trim();
        if (c) all.add(c);
      }
    } catch {}
    // 2) system_profiler, most reliable on macOS, includes Miracode
    try {
      const { stdout } = await pexec(`system_profiler SPFontsDataType 2>/dev/null | grep "Family:" | awk -F: '{print $2}' | sort | uniq`, { maxBuffer: 10 * 1024 * 1024 }) as any;
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
  handle("pideck:get-settings", () => getRuntime().getSettings());
  handle("pideck:set-settings", (_e, patch: any) => getRuntime().setSettings(patch));
  handle("pideck:set-session-name", (_e, name: string) => {
    if (typeof name !== "string" || name.length > 500) throw new Error("invalid session name");
    return getRuntime().setSessionName(name);
  });
  handle("pideck:compact", () => getRuntime().compact());

  // Branching / worktrees
  handle("pideck:get-tree", () => getRuntime().getTree());
  handle("pideck:get-history", () => getRuntime().getHistory());
  handle("pideck:turn-changes", (_e, entryId: unknown) => {
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    return getRuntime().getTurnChanges(entryId);
  });
  handle("pideck:turn-file-diff", (_e, entryId: unknown, path: unknown) => {
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    if (typeof path !== "string" || path.length < 1 || path.length > 4096) throw new Error("invalid file path");
    return getRuntime().getTurnFileDiff(entryId, path);
  });
  handle("pideck:rollback:prepare", (_e, entryId: string) => {
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    return getRuntime().prepareRollback(entryId);
  });
  handle("pideck:rollback:commit", (_e, planId: string) => {
    if (typeof planId !== "string" || !/^[0-9a-f-]{36}$/i.test(planId)) throw new Error("invalid rollback plan ID");
    return getRuntime().commitRollback(planId);
  });
  handle("pideck:rollback:undo", () => getRuntime().undoRollback());
  handle("pideck:get-fork-messages", () => getRuntime().getForkMessages());
  handle("pideck:fork", (_e, entryId: string) => {
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 200) throw new Error("invalid history entry ID");
    return getRuntime().fork(entryId);
  });
  handle("pideck:clone", () => getRuntime().clone());
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
