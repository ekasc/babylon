/**
 * Read targeting (Commit 9): every addressed read names its session (or its
 * project, for getModels). Missing identity is a protocol error at the
 * boundary; unknown paths reject instead of falling back to the foreground;
 * history/tree reads are cold-capable while runtime reads need a retained
 * runtime; and issuing reads never moves the foreground.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost } from "./pi-host";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-read-${tag}-`));
  const agentDir = await mkdtemp(join(tmpdir(), `pideck-read-agent-${tag}-`));
  roots.push(cwd, agentDir);
  return { cwd, agentDir };
}

function makeHost(cwd: string, agentDir: string) {
  return new PiHost({ cwd, agentDir, stateDir: join(agentDir, "state"), onEvent: () => undefined, onStatus: () => undefined });
}

describe("addressed reads require explicit identity", () => {
  it("rejects an empty session file on every addressed read", async () => {
    const { cwd, agentDir } = await makeProject("empty");
    const host = makeHost(cwd, agentDir);
    await host.start();
    try {
      await expect(host.getState("")).rejects.toThrow(/sessionFile is required/);
      await expect(host.getMessages("")).rejects.toThrow(/sessionFile is required/);
      await expect(host.getStats("")).rejects.toThrow(/sessionFile is required/);
      await expect(host.getHistory("")).rejects.toThrow(/sessionFile is required/);
      await expect(host.getTree("")).rejects.toThrow(/sessionFile is required/);
      await expect(host.getCommands("")).rejects.toThrow(/sessionFile is required/);
      await expect(host.getThinkingLevels("")).rejects.toThrow(/sessionFile is required/);
      await expect(host.getForkMessages("")).rejects.toThrow(/sessionFile is required/);
      await expect(host.getTurnChanges("", "e1")).rejects.toThrow(/sessionFile is required/);
      await expect(host.getToolOutput("", "tool-1")).rejects.toThrow(/sessionFile is required/);
    } finally {
      await host.dispose();
    }
  });

  it("rejects an unknown path on runtime reads instead of falling back", async () => {
    const { cwd, agentDir } = await makeProject("unknown");
    const host = makeHost(cwd, agentDir);
    await host.start();
    try {
      const missing = join(cwd, "nope.jsonl");
      await expect(host.getState(missing)).rejects.toThrow(/not available/i);
      await expect(host.getMessages(missing)).rejects.toThrow(/not available/i);
      await expect(host.getStats(missing)).rejects.toThrow(/not available/i);
    } finally {
      await host.dispose();
    }
  });

  it("reads cold history for an on-disk session while runtime reads still require a retained runtime", async () => {
    const { cwd, agentDir } = await makeProject("cold");
    const host = makeHost(cwd, agentDir);
    await host.start();
    try {
      // Create + seed the file WITHOUT ever opening it: no retained runtime.
      const sm = SessionManager.create(cwd);
      const file = sm.getSessionFile();
      if (!file) throw new Error("no canonical session file");
      const when = Date.now();
      sm.appendMessage({ role: "user", content: [{ type: "text", text: "cold read" }], timestamp: when });
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "cold answer" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: when + 1,
      });
      expect(host.testSessions().has(file)).toBe(false);

      const history = await host.getHistory(file);
      expect(Array.isArray(history.turns)).toBe(true);
      expect(history.turns.length).toBeGreaterThan(0);

      // Runtime-shaped reads still refuse: no retained runtime, no fallback.
      await expect(host.getState(file)).rejects.toThrow(/not available/i);
      expect(host.testSessions().has(file)).toBe(false);
      expect(host.testForegroundSessionFile()).toBeNull();
    } finally {
      await host.dispose();
    }
  });

  it("reads never move the foreground and never leak the foreground's content", async () => {
    const { cwd, agentDir } = await makeProject("fg");
    const host = makeHost(cwd, agentDir);
    await host.start();
    try {
      const seedTurn = (marker: string) => {
        const sm = SessionManager.create(cwd);
        const file = sm.getSessionFile();
        if (!file) throw new Error("no canonical session file");
        const when = Date.now();
        sm.appendMessage({ role: "user", content: [{ type: "text", text: marker }], timestamp: when });
        sm.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: `${marker} reply` }],
          api: "test",
          provider: "test",
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: when + 1,
        });
        return file;
      };
      const fileA = seedTurn("alpha-session-marker");
      const fileB = seedTurn("beta-session-marker");
      await host.open({ path: fileA, cwd });
      await host.open({ path: fileB, cwd });
      expect(host.activeSessionFile).toBe(fileB);

      await host.getState(fileA);
      const historyA = await host.getHistory(fileA);
      const messagesA = await host.getMessages(fileA);
      // Addressed content: A's turn, never the foreground's.
      expect(JSON.stringify(historyA.turns)).toContain("alpha-session-marker");
      expect(JSON.stringify(historyA.turns)).not.toContain("beta-session-marker");
      expect(JSON.stringify(messagesA)).toContain("alpha-session-marker");
      // Addressing a read never steals the foreground.
      expect(host.activeSessionFile).toBe(fileB);
      expect(host.testForegroundSessionFile()).toBe(fileB);
    } finally {
      await host.dispose();
    }
  });

  it("getModels is project-addressed and works with no session open", async () => {
    const { cwd, agentDir } = await makeProject("models");
    const host = makeHost(cwd, agentDir);
    await host.start();
    try {
      await expect(host.getModels(cwd)).resolves.toBeInstanceOf(Array);
      expect(host.testSessions().size).toBe(0);
      expect(host.testForegroundSessionFile()).toBeNull();
    } finally {
      await host.dispose();
    }
  });
});
