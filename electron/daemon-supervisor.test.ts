import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonPid, retireDaemon, type RetirePort } from "./daemon-supervisor";

/** A stub daemon: `alive` stands in for "something is listening on the
 *  socket", and `downOn` lists the signals that actually stop it. */
function harness(opts: { shutdown: "acks" | "rejects"; downOn?: NodeJS.Signals[]; pid?: number }) {
  const signals: NodeJS.Signals[] = [];
  let alive = true;
  let clock = 0;
  const port: RetirePort = {
    probe: async () => alive,
    requestShutdown: async () => {
      if (opts.shutdown === "rejects") throw new Error("unsupported request");
      alive = false;
    },
    signal: (_pid, signal) => {
      signals.push(signal);
      if (opts.downOn?.includes(signal)) alive = false;
    },
    readPidFile: () => opts.pid,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: () => {},
  };
  return { port, signals, isListening: () => alive };
}

describe("retiring an incompatible daemon", () => {
  it("stops at the shutdown request when the daemon honors it", async () => {
    const h = harness({ shutdown: "acks" });
    await expect(retireDaemon("/tmp/daemon.sock", "/tmp/daemon.pid", h.port)).resolves.toBe(true);
    expect(h.signals).toEqual([]);
  });

  it("forces a daemon that ignores shutdown out with SIGTERM", async () => {
    const h = harness({ shutdown: "rejects", downOn: ["SIGTERM"], pid: 4242 });
    await expect(retireDaemon("/tmp/daemon.sock", "/tmp/daemon.pid", h.port)).resolves.toBe(true);
    expect(h.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const h = harness({ shutdown: "rejects", downOn: ["SIGKILL"], pid: 4242 });
    await expect(retireDaemon("/tmp/daemon.sock", "/tmp/daemon.pid", h.port)).resolves.toBe(true);
    expect(h.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("fails closed when an unresponsive daemon left no pid to signal", async () => {
    const h = harness({ shutdown: "rejects" });
    await expect(retireDaemon("/tmp/daemon.sock", "/tmp/daemon.pid", h.port)).resolves.toBe(false);
    expect(h.signals).toEqual([]);
  });

  it("fails closed when a live daemon survives SIGKILL", async () => {
    const h = harness({ shutdown: "rejects", pid: 4242 });
    await expect(retireDaemon("/tmp/daemon.sock", "/tmp/daemon.pid", h.port)).resolves.toBe(false);
    expect(h.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("reading a daemon pid file", () => {
  it("returns the recorded pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "babylon-pid-"));
    const file = join(dir, "daemon.pid");
    writeFileSync(file, "12345\n");
    expect(readDaemonPid(file)).toBe(12345);
  });

  it("rejects a missing, malformed, or self-referential file", () => {
    const dir = mkdtempSync(join(tmpdir(), "babylon-pid-"));
    const file = join(dir, "daemon.pid");
    expect(readDaemonPid(join(dir, "absent.pid"))).toBeUndefined();
    writeFileSync(file, "not-a-pid");
    expect(readDaemonPid(file)).toBeUndefined();
    writeFileSync(file, "0");
    expect(readDaemonPid(file)).toBeUndefined();
    writeFileSync(file, String(process.pid));
    expect(readDaemonPid(file)).toBeUndefined();
  });
});
