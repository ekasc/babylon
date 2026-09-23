import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiHost, type HostOptions } from "./pi-host";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

/**
 * Contract the renderer's background refresh depends on: refreshFromDisk is
 * a pure disk sync that NEVER emits a foreground ready (a stale refresh
 * completing after a tab switch must not rebind the UI to the old session).
 * Both paths stay silent; the caller hydrates the session it displays
 * explicitly from the boolean result.
 */
describe("PiHost refreshFromDisk status contract", () => {
  it("syncs silently on success, nothing on miss, never a foreground ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-refresh-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);

    const statuses: Array<Parameters<HostOptions["onStatus"]>[0]> = [];
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

      // Hit (live file): returns true and stays silent — no ready, so a
      // refresh racing a tab switch can never hijack the foreground. The
      // sync itself still happened (state readable, foreground untouched).
      const foregroundBefore = host.activeSessionFile;
      const hit = await host.refreshFromDisk(file!);
      expect(hit).toBe(true);
      expect(statuses).toHaveLength(0);
      expect(host.activeSessionFile).toBe(foregroundBefore);
      expect((await host.getState()).sessionFile).toBe(file);
    } finally {
      await host.dispose();
    }
  }, 30_000);
});
