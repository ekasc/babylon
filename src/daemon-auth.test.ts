import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { daemonTokenPath, loadOrCreateDaemonToken } from "./daemon-auth";

const tempDirs: string[] = [];
afterEach(() => {
  tempDirs.length = 0;
  vi.unstubAllEnvs();
});

describe("daemon owner token", () => {
  it("provisions a 0600 token file and reuses it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-dtoken-"));
    tempDirs.push(dir);
    const first = loadOrCreateDaemonToken(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(daemonTokenPath(dir), "utf8").trim()).toBe(first);
    expect(statSync(daemonTokenPath(dir)).mode & 0o777).toBe(0o600);
    expect(loadOrCreateDaemonToken(dir)).toBe(first);
  });

  it("prefers an explicit env token and never writes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-dtoken-"));
    tempDirs.push(dir);
    vi.stubEnv("BABYLON_DAEMON_TOKEN", "a".repeat(64));
    expect(loadOrCreateDaemonToken(dir)).toBe("a".repeat(64));
    expect(() => statSync(daemonTokenPath(dir))).toThrow();
  });

  it("replaces a corrupt token file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-dtoken-"));
    tempDirs.push(dir);
    writeFileSync(daemonTokenPath(dir), "not-a-token\n");
    chmodSync(daemonTokenPath(dir), 0o600);
    const token = loadOrCreateDaemonToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe("not-a-token");
  });
});
