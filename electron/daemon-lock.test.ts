import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLifecycleLock,
  LifecycleLockedError,
  releaseLifecycleLock,
  type LifecycleLock,
} from "./daemon-lock";

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daemon-lock-"));
  lockPath = join(dir, "daemon.lifecycle-lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("lifecycle lock", () => {
  it("acquires and releases", async () => {
    const lock = await acquireLifecycleLock(lockPath);
    expect(lock.lockPath).toBe(lockPath);
    await releaseLifecycleLock(lock);
    // Releasing twice is a no-op: the lock is already gone.
    await releaseLifecycleLock(lock);
    // And the path is free again.
    const again = await acquireLifecycleLock(lockPath);
    await releaseLifecycleLock(again);
  });

  it("refuses a second holder while live", async () => {
    const lock = await acquireLifecycleLock(lockPath);
    await expect(acquireLifecycleLock(lockPath)).rejects.toBeInstanceOf(LifecycleLockedError);
    await releaseLifecycleLock(lock);
  });

  it("refuses to release another holder's lock", async () => {
    const lock = await acquireLifecycleLock(lockPath);
    const impostor: LifecycleLock = { lockPath, token: "not-the-owner" };
    await expect(releaseLifecycleLock(impostor)).rejects.toBeInstanceOf(LifecycleLockedError);
    // The real holder still owns it.
    await releaseLifecycleLock(lock);
  });

  it("reaps a dead owner and publishes itself", async () => {
    const deadPid = 2 ** 30; // ESRCH on any real machine, and signal 0 sends nothing.
    const first = await acquireLifecycleLock(lockPath, () => "live");
    // Forge the situation the reaper handles: rewrite the owner record with a
    // dead pid, as if the holder died without releasing.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      `${lockPath}/owner.json`,
      JSON.stringify({ pid: deadPid, token: first.token, createdAt: new Date().toISOString() }) + "\n"
    );
    const second = await acquireLifecycleLock(lockPath, (pid) => (pid === deadPid ? "dead" : "live"));
    expect(second.token).not.toBe(first.token);
    await releaseLifecycleLock(second);
  });

  it("treats an unknown owner process as live", async () => {
    await acquireLifecycleLock(lockPath);
    await expect(acquireLifecycleLock(lockPath, () => "unknown")).rejects.toBeInstanceOf(LifecycleLockedError);
  });
});
