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
import { join } from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";
import { startDaemonServer } from "../src/daemon-server";
import { hashToken } from "../src/remote-auth";
import { loadOrCreateDaemonToken } from "../src/daemon-auth";
import { PiHost, defaultStateDir } from "../electron/pi-host";
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
console.log(`babylon-daemon: listening on ${addressLabel}`);
console.log(`babylon-daemon: state persisted to ${snapshotPath}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    unlinkSync(pidFile);
  } catch {
    // Already gone.
  }
  await server.close();
  await piHost.dispose();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
