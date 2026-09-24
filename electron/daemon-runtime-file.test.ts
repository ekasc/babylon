import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readRuntimeFile,
  removeRuntimeFile,
  writeRuntimeFile,
  type DaemonRuntimeFile,
} from "./daemon-runtime-file";

let dir: string;
let path: string;

const info: DaemonRuntimeFile = {
  version: 1,
  pid: 1234,
  protocol: 2,
  build: "abc123",
  socketPath: "/tmp/daemon.sock",
  startedAt: "2026-09-18T00:00:00.000Z",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daemon-runtime-"));
  path = join(dir, "daemon-runtime.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("daemon runtime file", () => {
  it("round-trips", () => {
    writeRuntimeFile(path, info);
    expect(readRuntimeFile(path)).toEqual(info);
  });

  it("returns null for missing or garbage", async () => {
    expect(readRuntimeFile(path)).toBeNull();
    await writeFile(path, "{nope");
    expect(readRuntimeFile(path)).toBeNull();
    await writeFile(path, JSON.stringify({ ...info, version: 2 }));
    expect(readRuntimeFile(path)).toBeNull();
    await writeFile(path, JSON.stringify({ ...info, build: "" }));
    expect(readRuntimeFile(path)).toBeNull();
  });

  it("removes best-effort", () => {
    writeRuntimeFile(path, info);
    removeRuntimeFile(path);
    expect(readRuntimeFile(path)).toBeNull();
    removeRuntimeFile(path);
  });
});
