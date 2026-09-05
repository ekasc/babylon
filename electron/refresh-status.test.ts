import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiHost } from "./pi-host";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

/**
 * Contract the renderer's background refresh depends on: the true path must
 * rebind the live session (ready with state) because the false path emits
 * nothing, so the renderer must restore its own switching flag and must
 * never clear its active session id around the call.
 */
describe("PiHost refreshFromDisk status contract", () => {
  it("emits ready with state on success, nothing on miss", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-refresh-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);

    const statuses: any[] = [];
    const host = new PiHost({ cwd, agentDir, onEvent: () => undefined, onStatus: (s) => statuses.push(s) });
    await host.start();
    try {
      const opened = await host.open({ path: undefined, cwd });
      const file = opened?.sessionFile as string | undefined;
      expect(file).toBeTruthy();
      statuses.length = 0;

      // Miss (unknown file): returns false and must stay silent, the caller
      // self-restores, and no stale ready may rebind the live session.
      const missed = await host.refreshFromDisk(join(root, "nope.jsonl"));
      expect(missed).toBe(false);
      expect(statuses).toHaveLength(0);

      // Hit (live file): returns true and rebinds via ready with live state.
      const hit = await host.refreshFromDisk(file!);
      expect(hit).toBe(true);
      const ready = statuses.filter((s) => s?.status === "ready").pop();
      expect(ready).toBeDefined();
      expect(ready?.state?.sessionId).toBeTruthy();
    } finally {
      await host.dispose();
    }
  }, 30_000);
});
