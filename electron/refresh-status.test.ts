import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiHost } from "./pi-host";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

/**
 * refreshFromDisk is a pure disk sync. It publishes nothing at all: no status
 * event exists to emit, and it never changes execution ownership — so a
 * background refresh can never re-point the app at a different conversation.
 */
describe("PiHost refreshFromDisk contract", () => {
  it("syncs silently, reports a miss, and never changes ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-refresh-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);

    const host = new PiHost({ cwd, agentDir, onEvent: () => undefined });
    await host.start();
    try {
      const owner = await host.activateExecution(cwd);
      const file = owner.sessionFile;
      expect(file).toBeTruthy();

      // Miss (unknown file): false, no state change.
      expect(await host.refreshFromDisk(join(root, "nope.jsonl"))).toBe(false);
      expect(host.testExecutionByCwd().get(cwd)).toBe(file);

      // Hit (installed owner): true, ownership untouched, state readable.
      expect(await host.refreshFromDisk(file)).toBe(true);
      expect(host.testExecutionByCwd().get(cwd)).toBe(file);
      expect((await host.getState(file)).sessionFile).toBe(file);

      // A cold historical file syncs without installing a runtime.
      const before = host.testRuntimeCreationCount();
      expect(host.hasSessionRuntime(file)).toBe(true);
      expect(host.testRuntimeCreationCount()).toBe(before);
    } finally {
      await host.dispose();
    }
  }, 30_000);
});
