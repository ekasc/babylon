import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "./doctor";
import { acquireLifecycleLock, releaseLifecycleLock } from "./daemon-lock";
import { writeRuntimeFile } from "./daemon-runtime-file";

let root: string;
let dataDir: string;
let stateDir: string;

const BUILD = "test-build-id";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "babylon-doctor-"));
  dataDir = join(root, "userData");
  stateDir = join(root, "state");
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(stateDir, "rollbacks"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function settings(enabled: boolean): Promise<void> {
  await writeFile(join(dataDir, "pideck-settings.json"), JSON.stringify({ daemon: { enabled } }));
}

function labels(findings: { label: string }[]): string[] {
  return findings.map((f) => f.label);
}

describe("doctor", () => {
  it("passes a disabled daemon with nothing running", async () => {
    await settings(false);
    const { findings, ok } = await doctor({ dataDir, stateDir, sourceBuildId: BUILD });
    expect(ok).toBe(true);
    expect(labels(findings)).toContain("daemon disabled");
    expect(labels(findings)).toContain("election lock free");
  });

  it("passes a healthy live daemon", async () => {
    await settings(true);
    const sockPath = join(root, "daemon.sock");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      writeRuntimeFile(join(dataDir, "daemon-runtime.json"), {
        version: 1,
        pid: process.pid,
        protocol: 2,
        build: BUILD,
        socketPath: sockPath,
        startedAt: new Date().toISOString(),
      });
      await writeFile(join(stateDir, "rollbacks", "state.sqlite"), "x");
      const { findings, ok } = await doctor({ dataDir, stateDir, sourceBuildId: BUILD });
      expect(ok).toBe(true);
      expect(labels(findings)).toContain("socket accepts connections");
      expect(labels(findings)).toContain("daemon build matches sources");
    } finally {
      server.close();
    }
  });

  it("fails skew, dead holders, and stale locks with remedies", async () => {
    await settings(true);
    writeRuntimeFile(join(dataDir, "daemon-runtime.json"), {
      version: 1,
      pid: 2 ** 30,
      protocol: 2,
      build: "stale-build",
      socketPath: join(root, "missing.sock"),
      startedAt: new Date(0).toISOString(),
    });
    const lockPath = join(dataDir, "daemon.lifecycle-lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: 2 ** 30, token: "dead-owner", createdAt: new Date(0).toISOString() })
    );
    const { findings, ok } = await doctor({ dataDir, stateDir, sourceBuildId: BUILD });
    expect(ok).toBe(false);
    const byLabel = new Map(findings.map((f) => [f.label, f]));
    expect(byLabel.get("daemon build skew")?.status).toBe("fail");
    expect(byLabel.get("daemon build skew")?.remedy).toMatch(/build:daemon/);
    expect(byLabel.get("stale election lock")?.status).toBe("fail");
    const deadPid = [...byLabel.keys()].find((l) => l.includes("dead"));
    expect(deadPid).toBeDefined();
    expect(byLabel.get(deadPid!)?.remedy).toMatch(/restart pnpm dev/);
  });

  it("fails an unreachable socket on a live pid", async () => {
    await settings(true);
    writeRuntimeFile(join(dataDir, "daemon-runtime.json"), {
      version: 1,
      pid: process.pid,
      protocol: 2,
      build: BUILD,
      socketPath: join(root, "missing.sock"),
      startedAt: new Date().toISOString(),
    });
    const { findings, ok } = await doctor({ dataDir, stateDir, sourceBuildId: BUILD });
    expect(ok).toBe(false);
    const unreachable = findings.find((f) => f.label === "socket unreachable");
    expect(unreachable?.status).toBe("fail");
    expect(unreachable?.remedy).toMatch(/kill/);
  });

  it("warns on a lock held outside startup", async () => {
    await settings(true);
    const lock = await acquireLifecycleLock(join(dataDir, "daemon.lifecycle-lock"));
    try {
      const { findings } = await doctor({ dataDir, stateDir, sourceBuildId: BUILD });
      expect(findings.find((f) => f.label === "election lock held")?.status).toBe("warn");
    } finally {
      await releaseLifecycleLock(lock);
    }
  });

  it("warns on WAL without a live daemon", async () => {
    await settings(true);
    await writeFile(join(stateDir, "rollbacks", "state.sqlite"), "x");
    await writeFile(join(stateDir, "rollbacks", "state.sqlite-wal"), "x");
    const { findings } = await doctor({ dataDir, stateDir, sourceBuildId: BUILD });
    expect(findings.find((f) => f.label === "WAL without a live daemon")?.status).toBe("warn");
  });
});
