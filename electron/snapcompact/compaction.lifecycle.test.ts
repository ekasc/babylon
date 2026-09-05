import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiHost } from "../pi-host";
import { SessionManager, buildContextEntries } from "@earendil-works/pi-coding-agent";
import { saveSettings, getSettings } from "../app-settings";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

describe("snapcompact lifecycle regression (real PiHost.compact)", () => {
  let root = "";
  let cwd = "";
  let agentDir = "";
  let stateDir = "";
  let host: PiHost | null = null;
  let sessionFile = "";
  let originalMode: any = null;

  beforeEach(async () => {
    originalMode = getSettings().compaction?.mode;
  });

  afterEach(async () => {
    if (host) {
      await host.dispose().catch(() => {});
      host = null;
    }
    if (originalMode !== undefined) {
      saveSettings({ compaction: { mode: originalMode ?? "summary" } });
    }
    if (root) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      root = "";
    }
  });

  it("real persisted compact becomes active boundary, contextUsage null until post-response, survives reopen", async () => {
    root = await mkdtemp(join(tmpdir(), "pideck-lifecycle-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    stateDir = join(root, "state");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await exec("git", ["init"], { cwd });

    host = new PiHost({ cwd, agentDir, stateDir, onEvent: () => {}, onStatus: () => {} });
    await host.start();

    const sm0 = SessionManager.create(cwd, join(root, "sessions"));
    sessionFile = sm0.getSessionFile()!;
    await host.switchTo(sessionFile, { cwdOverride: cwd });

    // Ensure vision model with context window and fake auth so Pi's compact does not require real LLM
    const model = host.session.model!;
    expect(model).toBeDefined();
    // The default model (gpt-5.5) already supports images; ensure we have a fake key for the provider
    await (host.session as any)._modelRuntime.setRuntimeApiKey(model!.provider, "sk-fake-test-lifecycle");

    saveSettings({ compaction: { mode: "snapcompact" } });

    const sm = host.session.sessionManager;

    // Build enough history: 70 pairs ~ 140 messages + header, each ~2k chars
    for (let i = 0; i < 70; i++) {
      sm.appendMessage({ role: "user", content: `message ${i} ` + "x".repeat(2000), timestamp: Date.now() } as any);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `reply ${i} ` + "y".repeat(2000) }],
        provider: model!.provider,
        model: model!.id,
        api: (model as any).api ?? "openai",
        usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      } as any);
    }
    // Add a final large-usage assistant to make pre-compaction contextUsage large and deterministic
    sm.appendMessage({ role: "user", content: "final user " + "x".repeat(2000), timestamp: Date.now() } as any);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "final reply" }],
      provider: model!.provider,
      model: model!.id,
      api: (model as any).api ?? "openai",
      usage: { input: 50000, output: 10000, cacheRead: 0, cacheWrite: 0, totalTokens: 60000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    } as any);

    // Sync agent state so getSessionStats reflects the full history before compact
    (host.session.agent.state as any).messages = sm.buildSessionContext().messages;
    const beforeStats = host.session.getSessionStats();
    expect(beforeStats.contextUsage!.percent).not.toBeNull();
    expect(beforeStats.contextUsage!.tokens).toBeGreaterThan(10000);
    const beforeTokens = beforeStats.contextUsage!.tokens;

    // 2. Run actual PiHost.compact
    const result = await host.compact();
    expect(result).toBeDefined();
    expect(result.details?.snapcompactGeneration).toBeDefined();

    // 3. JSONL contains new CompactionEntry with snapcompactGeneration
    const raw = await readFile(sessionFile, "utf8");
    const fileEntries = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const compEntry = fileEntries.filter((e: any) => e.type === "compaction").pop();
    expect(compEntry).toBeDefined();
    expect(compEntry.details?.snapcompactGeneration).toBe(result.details.snapcompactGeneration);
    expect(compEntry.fromHook).toBe(true);

    // 4. getBranch contains compaction on active branch
    const branch = sm.getBranch();
    expect(branch.some((e: any) => e.id === compEntry.id)).toBe(true);
    expect(branch[branch.length - 1].id).toBe(compEntry.id);

    // 5. buildContextEntries resolves through compaction and excludes archived prefix
    const ctxEntries = buildContextEntries(sm.getEntries(), sm.getLeafId());
    expect(ctxEntries[0].id).toBe(compEntry.id);
    expect(ctxEntries[0].type).toBe("compaction");
    const firstUserId = fileEntries.find((e: any) => e.type === "message" && e.message?.role === "user")?.id;
    expect(firstUserId).toBeDefined();
    expect(ctxEntries.some((e: any) => e.id === firstUserId)).toBe(false);
    expect(ctxEntries.some((e: any) => e.id === result.firstKeptEntryId)).toBe(true);
    expect(ctxEntries.length).toBeLessThan(branch.length);

    // 6. Immediately after compact, contextUsage percent is null
    const afterStats = host.session.getSessionStats();
    expect(afterStats.contextUsage!.percent).toBeNull();
    expect(afterStats.contextUsage!.tokens).toBeNull();

    // 7. Reopen SAME JSONL with fresh SessionManager and PiHost, repeat 4-6
    const freshSM = SessionManager.open(sessionFile, undefined, cwd);
    const freshBranch = freshSM.getBranch();
    expect(freshBranch.some((e: any) => e.id === compEntry.id)).toBe(true);
    const freshCtx = buildContextEntries(freshSM.getEntries(), freshSM.getLeafId());
    expect(freshCtx[0].id).toBe(compEntry.id);
    expect(freshCtx.some((e: any) => e.id === firstUserId)).toBe(false);

    const host2 = new PiHost({ cwd, agentDir, stateDir, onEvent: () => {}, onStatus: () => {} });
    await host2.start();
    await host2.open({ cwd, path: sessionFile });
    // Re-apply fake key for the reopened host's model (may be same provider)
    const model2 = host2.session.model ?? model;
    if (model2) {
      await (host2.session as any)._modelRuntime.setRuntimeApiKey(model2.provider, "sk-fake-test-lifecycle-2");
    }
    const freshStats = host2.session.getSessionStats();
    expect(freshStats.contextUsage!.percent).toBeNull();
    expect(freshStats.contextUsage!.tokens).toBeNull();

    // 8. After mocked post-compaction assistant response with usage, context reflects new compacted context
    const newUsage = { input: 800, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 1200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    host2.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "post compact reply" }],
      provider: model2!.provider,
      model: model2!.id,
      api: (model2 as any).api ?? "openai",
      usage: newUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    } as any);
    (host2.session.agent.state as any).messages = host2.session.sessionManager.buildSessionContext().messages;
    const postStats = host2.session.getSessionStats();
    expect(postStats.contextUsage!.percent).not.toBeNull();
    expect(postStats.contextUsage!.tokens).not.toBeNull();
    expect(postStats.contextUsage!.tokens).toBeLessThan(beforeTokens!);
    expect(postStats.contextUsage!.tokens).not.toBe(beforeTokens);
    expect(postStats.contextUsage!.percent).toBeLessThan(beforeStats.contextUsage!.percent!);

    await host2.dispose();
  }, 60_000);
});
