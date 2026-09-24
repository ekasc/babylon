/**
 * Read targeting (Commit 9): every addressed read names its session (or its
 * project, for getModels). Missing identity is a protocol error at the
 * boundary; unknown paths reject instead of falling back to the foreground;
 * history/tree reads are cold-capable while runtime reads need a retained
 * runtime; and issuing reads never moves the foreground.
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  return new PiHost({ cwd, agentDir, stateDir: join(agentDir, "state"), onEvent: () => undefined });
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
      expect(host.executionForCwd(cwd)).toBeNull();
    } finally {
      await host.dispose();
    }
  });

  it("reads are addressed to their own project and never leak another project's content", async () => {
    const a = await makeProject("fg-a");
    const b = await makeProject("fg-b");
    const { cwd, agentDir } = a;
    const host = makeHost(cwd, agentDir);
    await host.start();
    try {
      // One runtime per project (R1): two live sessions means two projects.
      const seedTurn = (marker: string, project: string) => {
        const sm = SessionManager.create(project);
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
      const fileA = seedTurn("alpha-session-marker", a.cwd);
      const fileB = seedTurn("beta-session-marker", b.cwd);
      await host.activateExecution(a.cwd, fileA);
      await host.activateExecution(b.cwd, fileB);
      expect(host.testExecutionByCwd().get(b.cwd)).toBe(fileB);

      await host.getState(fileA);
      const stateA = await host.getState(fileA);
      const historyA = await host.getHistory(fileA);
      const messagesA = await host.getMessages(fileA);
      // getState is addressed too: never another session's state.
      expect(stateA.sessionFile).toBe(fileA);
      // Addressed content: A's turn, never the other project's.
      expect(JSON.stringify(historyA.turns)).toContain("alpha-session-marker");
      expect(JSON.stringify(historyA.turns)).not.toContain("beta-session-marker");
      expect(JSON.stringify(messagesA)).toContain("alpha-session-marker");
      // Addressing a read never changes ownership.
      expect(host.testExecutionByCwd().get(b.cwd)).toBe(fileB);
    } finally {
      await host.dispose();
    }
  });

  it("reads tool output from the addressed transcript only", async () => {
    const { cwd, agentDir } = await makeProject("toolout");
    const host = makeHost(cwd, agentDir);
    await host.start();
    try {
      const smA = SessionManager.create(cwd);
      const fileA = smA.getSessionFile();
      const smB = SessionManager.create(cwd);
      const fileB = smB.getSessionFile();
      if (!fileA || !fileB) throw new Error("no canonical session file");
      // A full turn first: SessionManager only flushes to disk once an
      // assistant message exists, and B must open as a real session.
      const seedTurn = (sm: SessionManager) => {
        const when = Date.now();
        sm.appendMessage({ role: "user", content: [{ type: "text", text: "run it" }], timestamp: when });
        sm.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          api: "test",
          provider: "test",
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: when + 1,
        });
      };
      seedTurn(smA);
      seedTurn(smB);
      // Identically-named tool call in BOTH transcripts with different output:
      // expanding A while B is foregrounded must read A's bytes. Entry keeps
      // the SDK's top-level id/parentId/timestamp so the loader indexes it.
      const line = (id: string, text: string) =>
        JSON.stringify({
          type: "message",
          id,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "toolResult", toolCallId: "call-shared", content: [{ type: "text", text }], timestamp: Date.now() },
        }) + "\n";
      await appendFile(fileA, line("tool-out-a", "OUTPUT-FROM-A"));
      await appendFile(fileB, line("tool-out-b", "OUTPUT-FROM-B"));
      // A stays historical (never activated); B owns the project.
      await host.activateExecution(cwd, fileB);
      expect(host.testExecutionByCwd().get(cwd)).toBe(fileB);
      expect(host.testSessions().has(fileA)).toBe(false);

      const fromA = await host.getToolOutput(fileA, "call-shared");
      expect(fromA.content).toBe("OUTPUT-FROM-A");
      const fromB = await host.getToolOutput(fileB, "call-shared");
      expect(fromB.content).toBe("OUTPUT-FROM-B");
      expect(host.testExecutionByCwd().get(cwd)).toBe(fileB);
    } finally {
      await host.dispose();
    }
  });

  it("getModels serves the requested project, never another project's catalogue", async () => {
    const a = await makeProject("models-a");
    const b = await makeProject("models-b");
    const writeCatalog = async (agentDir: string, modelId: string) =>
      writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              name: "Fixture",
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              apiKey: "sk-fixture",
              models: [{ id: modelId, name: modelId, reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 8_192 }],
            },
          },
        })
      );
    const ids = (list: Array<{ provider: string; id: string }>) => list.map((m) => `${m.provider}/${m.id}`);
    // v1 catalogue loads into project A's runtime at start().
    await writeCatalog(a.agentDir, "fixture-a");
    const host = makeHost(a.cwd, a.agentDir);
    await host.start();
    try {
      const idsA = ids(await host.getModels(a.cwd));
      expect(idsA).toContain("fixture/fixture-a");
      expect(idsA).not.toContain("fixture/fixture-b");

      // v2 on disk: project B's runtime is created AFTER the rewrite (its
      // session opens now), so the two projects' catalogues genuinely differ.
      await writeCatalog(a.agentDir, "fixture-b");
      const smB = SessionManager.create(b.cwd);
      const fileB = smB.getSessionFile();
      if (!fileB) throw new Error("no canonical session file");
      await host.activateExecution(b.cwd, fileB);
      expect(host.testExecutionByCwd().get(b.cwd)).toBe(fileB);

      const idsB = ids(await host.getModels(b.cwd));
      expect(idsB).toContain("fixture/fixture-b");
      expect(idsB).not.toContain("fixture/fixture-a");

      // Requesting project A while B executes must serve A's catalogue.
      const idsA2 = ids(await host.getModels(a.cwd));
      expect(idsA2).toContain("fixture/fixture-a");
      expect(idsA2).not.toContain("fixture/fixture-b");
      expect(host.testProjectRuntimes().has(resolve(a.cwd))).toBe(true);
      expect(host.testExecutionByCwd().get(b.cwd)).toBe(fileB);
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
      expect(host.executionForCwd(cwd)).toBeNull();
    } finally {
      await host.dispose();
    }
  });
});
