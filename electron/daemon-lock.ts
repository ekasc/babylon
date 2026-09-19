import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";

// Mutual exclusion for daemon lifecycle decisions (probe, retire, spawn).
// The daemon outlives the GUI and two GUIs can start at once, so the election
// must be atomic: whoever publishes the lock dir decides, everyone else waits
// and then adopts whoever won. Owner records carry pid plus a UUID token, so
// a recycled pid cannot impersonate a dead holder, and takeover re-verifies
// the token before removing anything.

export type PidLiveness = (pid: number) => "live" | "dead" | "unknown";

export const defaultLiveness: PidLiveness = (pid) => {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error: any) {
    return error?.code === "ESRCH" ? "dead" : "unknown";
  }
};

export class LifecycleLockedError extends Error {
  constructor(lockPath: string, detail: string) {
    super(`daemon lifecycle locked (${lockPath}): ${detail}`);
    this.name = "LifecycleLockedError";
  }
}

export type LifecycleLock = { lockPath: string; token: string };

export type LockStatus =
  | { held: false }
  | { held: true; pid: number; createdAt: string; live: "live" | "dead" | "unknown" };

/** Inspect the election without taking it. Total: never throws. */
export async function readLifecycleLock(
  lockPath: string,
  liveness: PidLiveness = defaultLiveness
): Promise<LockStatus> {
  let owner: Owner;
  try {
    owner = await readOwner(lockPath);
  } catch {
    return { held: false };
  }
  return { held: true, pid: owner.pid, createdAt: owner.createdAt, live: liveness(owner.pid) };
}

type Owner = { pid: number; token: string; createdAt: string };

async function readOwner(lockPath: string): Promise<Owner> {
  const stat = await fsp.lstat(lockPath);
  if (!stat.isDirectory()) throw new Error("lock path is not a directory");
  const text = await fsp.readFile(`${lockPath}/owner.json`, "utf8");
  const owner = JSON.parse(text) as Partial<Owner>;
  if (
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    typeof owner.token !== "string" ||
    !owner.token ||
    typeof owner.createdAt !== "string"
  ) {
    throw new Error("lock owner metadata is invalid");
  }
  return owner as Owner;
}

async function removeTree(path: string): Promise<void> {
  await fsp.rm(path, { recursive: true, force: true });
}

export async function acquireLifecycleLock(
  lockPath: string,
  liveness: PidLiveness = defaultLiveness
): Promise<LifecycleLock> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const owner: Owner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
    const staging = `${lockPath}.acquiring.${owner.pid}.${owner.token}`;
    await fsp.mkdir(staging, { recursive: true });
    try {
      // O_EXCL: exactly one publisher can claim a fresh name.
      const handle = await fsp.open(`${staging}/owner.json`, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (cause) {
      await removeTree(staging);
      throw cause;
    }
    try {
      // Atomic publish: exactly one staging dir can become the lock.
      await fsp.rename(staging, lockPath);
      return { lockPath, token: owner.token };
    } catch {
      await removeTree(staging);
    }
    // Someone holds it. Only a dead owner may be reaped, and only when its
    // token is unchanged since we observed it.
    let observed: Owner;
    try {
      observed = await readOwner(lockPath);
    } catch {
      if (attempt === 0) continue; // Raced a release; try publishing again.
      throw new LifecycleLockedError(lockPath, "owner is unreadable");
    }
    if (liveness(observed.pid) !== "dead") {
      throw new LifecycleLockedError(lockPath, `owner pid ${observed.pid} is live or unknown`);
    }
    if (attempt > 0) throw new LifecycleLockedError(lockPath, "dead owner could not be reaped safely");
    const current = await readOwner(lockPath).catch(() => null);
    if (!current || current.token !== observed.token) continue; // Changed under us; retry publish.
    const stale = `${lockPath}.stale.${observed.token}`;
    await fsp.rename(lockPath, stale);
    await removeTree(stale);
  }
  throw new LifecycleLockedError(lockPath, "acquisition failed");
}

export async function releaseLifecycleLock(lock: LifecycleLock): Promise<void> {
  let owner: Owner;
  try {
    owner = await readOwner(lock.lockPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  // Never free another holder's lock.
  if (owner.token !== lock.token) {
    throw new LifecycleLockedError(lock.lockPath, "refusing to release another holder's lock");
  }
  const released = `${lock.lockPath}.released.${lock.token}`;
  await fsp.rename(lock.lockPath, released);
  await removeTree(released);
}
