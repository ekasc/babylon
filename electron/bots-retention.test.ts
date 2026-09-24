import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings } from "../src/bridge";

// bots-ipc resolves a userData path at registration time.
const { electronPaths } = vi.hoisted(() => ({ electronPaths: { userData: "" } }));
vi.mock("electron", () => ({ app: { getPath: () => electronPaths.userData } }));
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost, type HostOptions } from "./pi-host";
import { BotStore } from "./bots";
import { ProjectSettingsStore, projectHashForCwd } from "./project-settings";
import { registerBotsIpc } from "./bots-ipc";
import type { IpcHandle } from "./ipc-handle";
import type { SessionIndex } from "./sessions";
import type { TaskManager } from "./task-manager";
import type { RuntimeFacade } from "../src/runtime-facade";
import { toExecutionActivateResult } from "../src/execution";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-bot-retain-${tag}-`));
  const agentDir = await mkdtemp(join(tmpdir(), `pideck-bot-retain-agent-${tag}-`));
  const state = await mkdtemp(join(tmpdir(), `pideck-bot-retain-state-${tag}-`));
  roots.push(cwd, agentDir, state);
  return { cwd, agentDir, state };
}

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown;

function makeHarness(host: PiHost, botStore: BotStore, projectSettings: ProjectSettingsStore, stateDir: string, activeCwd: string) {
  const sessionsRoot = stateDir;
  electronPaths.userData = stateDir;
  const handlers = new Map<string, Handler>();
  const handle = ((channel: string, fn: Handler) => handlers.set(channel, fn)) as IpcHandle;
  // The compatibility open is the thing bots must NOT need: any call to it
  // is a runtime created outside the ownership claim.
  const compatOpen = vi.fn(async () => {
    throw new Error("compat openSession must not be used by bots");
  });
  const runtime = {
    executionActivate: async (cwd: string, sessionFile?: string, opts?: { systemPrompt?: string | null }) => {
      try {
        const entry = await host.activateExecution(cwd, sessionFile, opts);
        return {
          ok: true as const,
          execution: {
            cwd: entry.cwd,
            sessionFile: entry.sessionFile,
            sessionId: entry.sessionId,
            state: "idle" as const,
            streaming: false,
            generation: 1,
          },
        };
      } catch (err) {
        const busy = toExecutionActivateResult(err);
        if (busy) return busy;
        throw err;
      }
    },
    openSession: compatOpen,
  } as unknown as RuntimeFacade;

  registerBotsIpc(handle, {
    sessionsRoot,
    botStore,
    projectSettings,
    sessionIndex: { get: () => null, set: () => undefined, all: () => [] } as unknown as SessionIndex,
    taskManager: { resumeForSession: () => undefined } as unknown as TaskManager,
    getRuntime: () => runtime,
    getHost: () => host,
    isDaemonOwned: () => false,
    getHostReady: () => null,
    getActiveCwd: () => activeCwd,
    broadcastBots: () => undefined,
    broadcastGroups: () => undefined,
    projectSettingsForCwd: (cwd: string) => {
      const hash = projectHashForCwd(cwd);
      const settings = projectSettings.getByHash(hash);
      if (!settings) throw new Error(`no settings for ${hash}`);
      return { settings, hash };
    },
    resolveCanonicalSessionFile: async (stored) => stored ?? undefined,
    overlayForSessionFile: () => null,
    driveExtrasIO: () => ({
      prompt: async () => undefined,
      readReply: async () => "",
      emit: () => undefined,
    }),
    lastAssistantText: () => "",
  });
  return { handlers, invoke: (channel: string, ...args: unknown[]) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn({}, ...args);
  }, compatOpen };
}

function makeHost(cwd: string, agentDir: string) {
  const host = new PiHost({
    cwd,
    agentDir,
    stateDir: join(agentDir, "pideck-state"),
    onEvent: () => undefined,
    onStatus: () => undefined,
  } satisfies HostOptions);
  return host;
}

describe("C10 retention: bot and group opens claim execution", () => {
  it("a busy project rejects the bot open without creating a bot runtime", async () => {
    const p = await makeProject("bot-busy");
    const host = makeHost(p.cwd, p.agentDir);
    await host.start();
    try {
      const botStore = new BotStore(join(p.state, "bots.json"));
      const bot = botStore.create({ name: "scout", cwd: p.cwd });
      const h = makeHarness(host, botStore, new ProjectSettingsStore(join(p.state, "projects")), p.state, p.cwd);

      // The project already has a running owner.
      const owner = SessionManager.create(p.cwd).getSessionFile()!;
      await host.activateExecution(p.cwd, owner);
      Object.defineProperty(host.testSessions().get(owner)!.runtime.session, "isStreaming", { value: true, configurable: true });
      const createdBefore = host.testRuntimeCreationCount();

      await expect(h.invoke("pideck:bots-open", bot.id)).rejects.toThrow(/busy/);
      // Nothing was built: the busy owner is still the only runtime.
      expect(h.compatOpen).not.toHaveBeenCalled();
      expect(host.testRuntimeCreationCount()).toBe(createdBefore);
      expect(host.testSessions().size).toBe(1);
      expect(host.testExecutionByCwd().get(p.cwd)).toBe(owner);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("an idle project's bot chat becomes its single execution owner", async () => {
    const p = await makeProject("bot-idle");
    const host = makeHost(p.cwd, p.agentDir);
    await host.start();
    try {
      const botStore = new BotStore(join(p.state, "bots.json"));
      const bot = botStore.create({ name: "scout", cwd: p.cwd });
      const h = makeHarness(host, botStore, new ProjectSettingsStore(join(p.state, "projects")), p.state, p.cwd);

      // An existing conversation owns the project first.
      const previous = SessionManager.create(p.cwd).getSessionFile()!;
      await host.activateExecution(p.cwd, previous);

      const result = (await h.invoke("pideck:bots-open", bot.id)) as { sessionFile: string };
      expect(result.sessionFile).toBeTruthy();
      expect(h.compatOpen).not.toHaveBeenCalled();
      // The bot chat took the slot: the previous runtime is gone, exactly one
      // runtime remains, and it is the project's owner.
      expect(host.testSessions().has(previous)).toBe(false);
      expect(host.testSessions().size).toBe(1);
      expect(host.testSessions().get(result.sessionFile)?.cwd).toBe(p.cwd);
      expect(host.testExecutionByCwd().get(p.cwd)).toBe(result.sessionFile);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("a busy project rejects the group room open without creating a room runtime", async () => {
    const p = await makeProject("group-busy");
    const host = makeHost(p.cwd, p.agentDir);
    await host.start();
    try {
      const botStore = new BotStore(join(p.state, "bots.json"));
      const one = botStore.create({ name: "one", cwd: p.cwd });
      const two = botStore.create({ name: "two", cwd: p.cwd });
      const group = botStore.createGroup({ name: "pair", memberIds: [one.id, two.id], cwd: p.cwd });
      const h = makeHarness(host, botStore, new ProjectSettingsStore(join(p.state, "projects")), p.state, p.cwd);

      const owner = SessionManager.create(p.cwd).getSessionFile()!;
      await host.activateExecution(p.cwd, owner);
      Object.defineProperty(host.testSessions().get(owner)!.runtime.session, "isStreaming", { value: true, configurable: true });
      const createdBefore = host.testRuntimeCreationCount();

      await expect(h.invoke("pideck:groups-open", group.id)).rejects.toThrow(/busy/);
      expect(h.compatOpen).not.toHaveBeenCalled();
      expect(host.testRuntimeCreationCount()).toBe(createdBefore);
      expect(host.testSessions().size).toBe(1);
      expect(host.testExecutionByCwd().get(p.cwd)).toBe(owner);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("an idle group's room session becomes the project's single owner", async () => {
    const p = await makeProject("group-idle");
    const host = makeHost(p.cwd, p.agentDir);
    await host.start();
    try {
      const botStore = new BotStore(join(p.state, "bots.json"));
      const one = botStore.create({ name: "one", cwd: p.cwd });
      const two = botStore.create({ name: "two", cwd: p.cwd });
      const group = botStore.createGroup({ name: "pair", memberIds: [one.id, two.id], cwd: p.cwd });
      const h = makeHarness(host, botStore, new ProjectSettingsStore(join(p.state, "projects")), p.state, p.cwd);

      const result = (await h.invoke("pideck:groups-open", group.id)) as { sessionFile: string };
      expect(h.compatOpen).not.toHaveBeenCalled();
      expect(host.testSessions().size).toBe(1);
      expect(host.testExecutionByCwd().get(p.cwd)).toBe(result.sessionFile);
      host.testAssertRetentionInvariant();
    } finally {
      await host.dispose();
    }
  }, 60_000);
});
