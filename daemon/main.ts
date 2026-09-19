// Standalone Babylon daemon entry point (Phase 6, Feature 13).
//
// Runs the daemon server as its own process so background execution survives
// the desktop app: closing Babylon's GUI leaves this process holding runtime
// authority, and a reopened app reconnects over the same socket.
//
// Configuration (environment variables):
//   BABYLON_DAEMON_SOCKET   unix socket path to listen on
//   BABYLON_DAEMON_PORT     TCP port to listen on instead of a unix socket
//   BABYLON_DAEMON_TOKEN    owner bearer token for TCP mode (else read from
//                           or provisioned at ~/.babylon/daemon-token, 0600)
//   BABYLON_DAEMON_SNAPSHOT state persistence file
//   BABYLON_DAEMON_TICK_MS  background policy tick interval (0 disables)

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";
import { startDaemonServer } from "../src/daemon-server";
import { hashToken } from "../src/remote-auth";
import { loadOrCreateDaemonToken } from "../src/daemon-auth";
import { PiHost, defaultStateDir } from "../electron/pi-host";
import { DAEMON_PROTOCOL_VERSION } from "../src/daemon-protocol";
import { buildId } from "../src/build-info";
import { removeRuntimeFile, writeRuntimeFile } from "../electron/daemon-runtime-file";
import { HookManager } from "../electron/hook-manager";
import { PermissionEngine, type AgentAction, type Risk } from "../electron/permissions";
import { listSessions } from "../electron/sessions";

function fail(message: string): never {
  console.error(`babylon-daemon: ${message}`);
  process.exit(1);
}

const portRaw = process.env.BABYLON_DAEMON_PORT;
const port = portRaw !== undefined ? Number(portRaw) : undefined;
if (portRaw !== undefined && (!Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65535)) {
  fail(`BABYLON_DAEMON_PORT must be an integer between 1 and 65535, got ${portRaw}`);
}

const tickRaw = process.env.BABYLON_DAEMON_TICK_MS;
const policyTickMs = tickRaw !== undefined ? Number(tickRaw) : undefined;
if (tickRaw !== undefined && (!Number.isFinite(policyTickMs) || (policyTickMs as number) < 0)) {
  fail(`BABYLON_DAEMON_TICK_MS must be a non-negative number, got ${tickRaw}`);
}

const babylonDir = join(homedir(), ".babylon");
const listen = port !== undefined ? { port, host: "127.0.0.1" } : { socketPath: process.env.BABYLON_DAEMON_SOCKET ?? join(babylonDir, "daemon.sock") };
const snapshotPath = process.env.BABYLON_DAEMON_SNAPSHOT ?? join(babylonDir, "daemon-state.json");
// Records this process so a client built from other source can retire it even
// when it is too old or too stuck to answer a shutdown request.
const pidFile = process.env.BABYLON_DAEMON_PID_FILE ?? join(babylonDir, "daemon.pid");
// Advertisement for clients and diagnostics, next to the pid file so a GUI
// started against another userData still finds its own. Written only once
// listening, like the pid file, and may be overridden for tests.
const runtimeFile = process.env.BABYLON_DAEMON_RUNTIME_FILE ?? join(dirname(pidFile), "daemon-runtime.json");

const defaultProject = process.env.BABYLON_DAEMON_DEFAULT_PROJECT ?? "";
const sessionGroups = await listSessions(defaultProject || undefined).catch(() => []);
const initialCwd = sessionGroups[0]?.cwd ?? (defaultProject || homedir());
const hookManager = new HookManager();
const permissionDir = process.env.BABYLON_DAEMON_PERMISSIONS_DIR ?? join(babylonDir, "pideck-state", "permissions");
const permissionEngine = new PermissionEngine({ dir: permissionDir });
await permissionEngine.load();

// Approvals raised by the daemon-owned PiHost are routed to connected clients
// through the daemon server once it is listening. Until then (no client can
// prompt yet), fail closed.
let approvalRequester: ((action: AgentAction, risk: Risk, sessionId?: string) => Promise<boolean>) | null = null;
const requestApproval = (action: AgentAction, risk: Risk, sessionId?: string): Promise<boolean> =>
  approvalRequester ? approvalRequester(action, risk, sessionId) : Promise.resolve(false);

const piHost = new PiHost({
  cwd: initialCwd,
  agentDir: process.env.BABYLON_DAEMON_AGENT_DIR,
  sessionsRoot: process.env.BABYLON_SESSIONS_ROOT,
  stateDir: process.env.BABYLON_DAEMON_STATE_DIR ?? defaultStateDir(process.env.BABYLON_DAEMON_AGENT_DIR),
  hookManager,
  permission: {
    evaluate: (action, sessionId?) => permissionEngine.evaluate(action, sessionId),
    requestApproval,
    clearSessionRules: (sessionId?: string) => permissionEngine.clearSessionRules(sessionId),
    getMode: () => permissionEngine.getMode(),
    listRules: () => permissionEngine.listRules(),
  },
  onEvent: () => {},
  onStatus: () => {},
});
await piHost.start();

const server = await startDaemonServer({
  listen,
  snapshotPath,
  ...(policyTickMs !== undefined ? { policyTickMs } : {}),
  // TCP loopback has no filesystem-permission equivalent, so TCP mode
  // requires every connection to present the owner token first. The Unix
  // socket keeps implicit trust and gets no gate.
  ...(port !== undefined
    ? { authTokenHash: hashToken(loadOrCreateDaemonToken(babylonDir)) }
    : {}),
  piHost,
  isDraining: () => piHost.isDraining(),
  permissionEngine,
  hookManager,
  // A client built from other source retires this daemon instead of speaking a
  // mismatched protocol; `stop` is hoisted so it can be referenced here.
  onShutdown: () => void stop(),
  log: (message) => console.log(`babylon-daemon: ${message}`),
});
approvalRequester = (action, risk, sessionId?) => server.requestApproval(action, risk, sessionId);

// Written only once the daemon is actually listening, so the file never points
// at a process that failed to start.
writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });

const address = server.address();
const addressLabel =
  "socketPath" in address ? address.socketPath : `${address.host ?? "127.0.0.1"}:${address.port}`;
writeRuntimeFile(runtimeFile, {
  version: 1,
  pid: process.pid,
  protocol: DAEMON_PROTOCOL_VERSION,
  build: buildId(),
  socketPath: addressLabel,
  startedAt: new Date().toISOString(),
});
console.log(`babylon-daemon: listening on ${addressLabel}`);
console.log(`babylon-daemon: state persisted to ${snapshotPath}`);

let stopping = false;
// retireDaemon waits SHUTDOWN_WAIT_MS (5s) for exit after requesting it; the
// drain deadline fits inside with slack left for close and dispose.
const DRAIN_TIMEOUT_MS = 4000;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    unlinkSync(pidFile);
  } catch {
    // Already gone.
  }
  removeRuntimeFile(runtimeFile);
  // Fail new turns fast, then let live ones finish before tearing down.
  piHost.beginDrain();
  await piHost.drainTurns(DRAIN_TIMEOUT_MS);
  await server.close();
  await piHost.dispose();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
