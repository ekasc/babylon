// Retiring a daemon that was built from different source.
//
// The daemon is detached and outlives the GUI, so a newer app can meet an older
// daemon holding the socket. Asking it to stop is the normal path. When it is
// too old to understand the request, or too stuck to act on it, the pid the
// daemon recorded at startup is the only remaining handle. Both paths live here
// rather than inline in main.ts so the process-signalling logic is unit-tested
// against a stub instead of only being exercised in production.
import { readFileSync } from "node:fs";

export interface RetirePort {
  /** True while something is listening on the socket. */
  probe(socketPath: string, timeoutMs: number): Promise<boolean>;
  /** Ask the daemon to exit; rejects when it does not understand the request. */
  requestShutdown(socketPath: string): Promise<void>;
  /** Deliver a signal, or throw when the process no longer exists. */
  signal(pid: number, signal: NodeJS.Signals): void;
  /** Pid recorded by the daemon at startup, or undefined when unusable. */
  readPidFile(pidPath: string): number | undefined;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(message: string): void;
}

const PROBE_TIMEOUT_MS = 300;
const POLL_MS = 100;
const SHUTDOWN_WAIT_MS = 5_000;
const SIGNAL_WAIT_MS = 5_000;
const KILL_WAIT_MS = 2_000;

/** Pid recorded by a daemon, or undefined when absent, malformed, or self. */
export function readDaemonPid(pidPath: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function waitForClose(socketPath: string, timeoutMs: number, port: RetirePort): Promise<boolean> {
  const deadline = port.now() + timeoutMs;
  while (port.now() < deadline) {
    if (!(await port.probe(socketPath, PROBE_TIMEOUT_MS))) return true;
    await port.sleep(POLL_MS);
  }
  return false;
}

/**
 * Retire the daemon on `socketPath`. Returns true once nothing is listening,
 * false when it could not be removed (it is then unsafe to keep, so the caller
 * must fail closed rather than speak its protocol).
 */
export async function retireDaemon(socketPath: string, pidPath: string, port: RetirePort): Promise<boolean> {
  try {
    await port.requestShutdown(socketPath);
  } catch {
    // Too old to understand shutdown; the liveness wait below decides.
  }
  if (await waitForClose(socketPath, SHUTDOWN_WAIT_MS, port)) return true;

  const pid = port.readPidFile(pidPath);
  if (pid === undefined) {
    port.log("[pideck] daemon ignored shutdown and left no pid file; cannot retire it");
    return false;
  }

  port.log(`[pideck] daemon ignored shutdown; sending SIGTERM to pid ${pid}`);
  try {
    port.signal(pid, "SIGTERM");
  } catch {
    // The process is gone; the socket may still be closing.
    return !(await port.probe(socketPath, PROBE_TIMEOUT_MS));
  }
  if (await waitForClose(socketPath, SIGNAL_WAIT_MS, port)) return true;

  port.log(`[pideck] daemon ignored SIGTERM; sending SIGKILL to pid ${pid}`);
  try {
    port.signal(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  return waitForClose(socketPath, KILL_WAIT_MS, port);
}
