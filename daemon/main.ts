// Standalone Babylon daemon entry point (Phase 6, Feature 13).
//
// Runs the daemon server as its own process so background execution survives
// the desktop app: closing Babylon's GUI leaves this process holding runtime
// authority, and a reopened app reconnects over the same socket.
//
// Configuration (environment variables):
//   BABYLON_DAEMON_SOCKET   unix socket path to listen on
//   BABYLON_DAEMON_PORT     TCP port to listen on instead of a unix socket
//   BABYLON_DAEMON_SNAPSHOT state persistence file
//   BABYLON_DAEMON_TICK_MS  background policy tick interval (0 disables)

import { homedir } from "node:os";
import { join } from "node:path";
import { startDaemonServer } from "../src/daemon-server";
import { PiHost } from "../electron/pi-host";
import { HookManager } from "../electron/hook-manager";
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

const defaultProject = process.env.BABYLON_DAEMON_DEFAULT_PROJECT ?? "";
const sessionGroups = await listSessions(defaultProject || undefined).catch(() => []);
const initialCwd = sessionGroups[0]?.cwd ?? (defaultProject || homedir());
const hookManager = new HookManager();
const piHost = new PiHost({
  cwd: initialCwd,
  agentDir: process.env.BABYLON_DAEMON_AGENT_DIR,
  stateDir: process.env.BABYLON_DAEMON_STATE_DIR ?? join(babylonDir, "pideck-state"),
  hookManager,
  onEvent: () => {},
  onStatus: () => {},
});
await piHost.start();

const server = await startDaemonServer({
  listen,
  snapshotPath,
  ...(policyTickMs !== undefined ? { policyTickMs } : {}),
  piHost,
  log: (message) => console.log(`babylon-daemon: ${message}`),
});

const address = server.address();
const addressLabel =
  "socketPath" in address ? address.socketPath : `${address.host ?? "127.0.0.1"}:${address.port}`;
console.log(`babylon-daemon: listening on ${addressLabel}`);
console.log(`babylon-daemon: state persisted to ${snapshotPath}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.close();
  await piHost.dispose();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
