/**
 * Recap ownership (Commit 9): the auto-recap sweep visits EXECUTION OWNERS
 * per project — never the foreground, never retained non-owners — and skips
 * owners whose execution is busy.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost } from "./pi-host";

const { tailCalls } = vi.hoisted(() => ({ tailCalls: [] as string[] }));
vi.mock("./sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sessions")>();
  return {
    ...actual,
    readSessionTail: async (path: string, maxBytes?: number) => {
      tailCalls.push(path);
      return actual.readSessionTail(path, maxBytes);
    },
  };
});

const roots: string[] = [];
const originalRecapMs = process.env.PIDECK_RECAP_MS;
afterAll(async () => {
  if (originalRecapMs === undefined) delete process.env.PIDECK_RECAP_MS;
  else process.env.PIDECK_RECAP_MS = originalRecapMs;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-recap-${tag}-`));
  const agentDir = await mkdtemp(join(tmpdir(), `pideck-recap-agent-${tag}-`));
  roots.push(cwd, agentDir);
  return { cwd, agentDir };
}

function seed(cwd: string): string {
  const sm = SessionManager.create(cwd);
  const file = sm.getSessionFile();
  if (!file) throw new Error("no canonical session file");
  const old = Date.now() - 10 * 60_000;
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "seed question" }], timestamp: old });
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "seed answer with enough substance to be worth summarizing later on" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: old + 1,
  });
  return file;
}

describe("recap sweep targets execution owners only", () => {
  it("recaps quiet owners across projects, never the viewed non-owner, and skips busy owners", async () => {
    const a = await makeProject("a");
    const b = await makeProject("b");
    const host = new PiHost({ cwd: a.cwd, agentDir: a.agentDir, stateDir: join(a.agentDir, "state"), onEvent: () => undefined, onStatus: () => undefined });
    await host.start();
    try {
      const fileA = seed(a.cwd);
      const fileB = seed(b.cwd);
      const fileC = seed(a.cwd); // retained non-owner in project A

      await host.open({ path: fileA, cwd: a.cwd });
      await host.activateExecution(a.cwd, fileA);
      await host.open({ path: fileB, cwd: b.cwd });
      await host.activateExecution(b.cwd, fileB);
      // Foreground ends on the retained non-owner: viewed ≠ recapped.
      await host.open({ path: fileC, cwd: a.cwd });
      expect(host.activeSessionFile).toBe(fileC);

      // Both owners were just opened: clear the in-memory quiet clock and
      // fast-forward the interval so the sweep treats them as due.
      await new Promise((resolve) => setTimeout(resolve, 10));
      process.env.PIDECK_RECAP_MS = "1";
      tailCalls.length = 0;
      await host.testSweepRecap();
      expect(new Set(tailCalls)).toEqual(new Set([fileA, fileB]));

      // A busy owner is skipped; the other project's owner still recaps.
      Object.defineProperty(host.testSessions().get(fileA)!.runtime.session, "isStreaming", { value: true, configurable: true });
      tailCalls.length = 0;
      await host.testSweepRecap();
      expect(tailCalls).toEqual([fileB]);
      expect(host.activeSessionFile).toBe(fileC);
    } finally {
      if (originalRecapMs === undefined) delete process.env.PIDECK_RECAP_MS;
      else process.env.PIDECK_RECAP_MS = originalRecapMs;
      await host.dispose();
    }
  }, 60_000);
});
