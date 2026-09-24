import { existsSync, promises as fsp } from "node:fs";
import { join } from "node:path";
import * as net from "node:net";
import { wireOf } from "../src/store";
import { readLifecycleLock } from "./daemon-lock";
import { readRuntimeFile } from "./daemon-runtime-file";

// babylon doctor: explain the daemon setup instead of making the user infer
// it from logs. Every check is a read (filesystem, pid signal, socket
// connect); nothing here starts, stops, or locks anything. Findings carry the
// remedy, because a diagnosis without one is just a fancier error.

export type DoctorStatus = "pass" | "warn" | "fail";

export type DoctorFinding = {
  status: DoctorStatus;
  label: string;
  detail?: string;
  remedy?: string;
};

export type DoctorInput = {
  /** Electron userData dir under inspection. */
  dataDir: string;
  /** PiHost state dir holding rollbacks/state.sqlite. */
  stateDir: string;
  /** Build id of the sources asking, for skew detection. */
  sourceBuildId: string;
};

function pidAlive(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH" ? "dead" : "unknown";
  }
}

function probeSocket(path: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const socket = net.connect(path);
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

export async function doctor(input: DoctorInput): Promise<{ findings: DoctorFinding[]; ok: boolean }> {
  const findings: DoctorFinding[] = [];
  const { dataDir, stateDir, sourceBuildId } = input;

  let daemonEnabled: boolean | null = null;
  try {
    const settings: unknown = JSON.parse(await fsp.readFile(join(dataDir, "pideck-settings.json"), "utf8"));
    daemonEnabled = wireOf(wireOf(settings)?.daemon)?.enabled === true;
  } catch {
    daemonEnabled = null;
  }
  if (daemonEnabled === false) {
    findings.push({ status: "pass", label: "daemon disabled", detail: "pideck-settings.json disables the daemon; nothing should be running." });
  } else if (daemonEnabled === null) {
    findings.push({ status: "warn", label: "settings unreadable", detail: "no pideck-settings.json; assuming the daemon should run." });
  }

  const runtime = readRuntimeFile(join(dataDir, "daemon-runtime.json"));
  if (!runtime) {
    findings.push({
      status: daemonEnabled === false ? "pass" : "warn",
      label: "no daemon advertisement",
      detail: "no daemon-runtime.json; the daemon never started or was never enabled here.",
    });
  } else {
    const alive = pidAlive(runtime.pid);
    findings.push({
      status: alive === "live" ? "pass" : "fail",
      label: `daemon pid ${runtime.pid} ${alive}`,
      detail: `protocol ${runtime.protocol}, build ${runtime.build}, started ${runtime.startedAt}, socket ${runtime.socketPath}`,
      remedy: alive === "live" ? undefined : "The advertisement points at a dead process; restart pnpm dev to elect a fresh holder.",
    });
    if (alive === "live") {
      const listening = runtime.socketPath.startsWith("/") ? await probeSocket(runtime.socketPath) : false;
      findings.push({
        status: listening ? "pass" : "fail",
        label: listening ? "socket accepts connections" : "socket unreachable",
        detail: runtime.socketPath,
        remedy: listening ? undefined : `The process is alive but not listening; kill ${runtime.pid} and restart pnpm dev.`,
      });
    }
    if (runtime.build !== sourceBuildId) {
      findings.push({
        status: "fail",
        label: "daemon build skew",
        detail: `running ${runtime.build} vs sources ${sourceBuildId}`,
        remedy: "Restart pnpm dev; startup retires the stale holder automatically. If the handshake still refuses, run pnpm build:daemon, then restart.",
      });
    } else {
      findings.push({ status: "pass", label: "daemon build matches sources", detail: runtime.build });
    }
  }

  const lock = await readLifecycleLock(join(dataDir, "daemon.lifecycle-lock"));
  if (!lock.held) {
    findings.push({ status: "pass", label: "election lock free" });
  } else if (lock.live === "dead") {
    findings.push({
      status: "fail",
      label: "stale election lock",
      detail: `held by dead pid ${lock.pid} since ${lock.createdAt}`,
      remedy: "It reaps on next startup; if startups hang, delete daemon.lifecycle-lock and restart pnpm dev.",
    });
  } else {
    findings.push({
      status: "warn",
      label: "election lock held",
      detail: `holder pid ${lock.pid} is ${lock.live}; the lock should only exist during startup elections.`,
    });
  }

  const dbPath = join(stateDir, "rollbacks", "state.sqlite");
  if (!existsSync(dbPath)) {
    findings.push({ status: "warn", label: "no state database", detail: "no rollbacks/state.sqlite; fresh or wiped." });
  } else {
    findings.push({ status: "pass", label: "state database present", detail: dbPath });
    const wal = existsSync(`${dbPath}-wal`);
    const holderLive = runtime ? pidAlive(runtime.pid) === "live" : false;
    if (wal && !holderLive) {
      findings.push({
        status: "warn",
        label: "WAL without a live daemon",
        detail: "an unclean exit left write-ahead state; the next open recovers it automatically.",
      });
    }
  }

  return { findings, ok: !findings.some((f) => f.status === "fail") };
}
