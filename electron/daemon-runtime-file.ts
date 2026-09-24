import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

// What a live daemon advertises about itself, written once it is listening so
// the file never points at a process that failed to start. Advisory only: the
// lifecycle lock elects, the socket probe verifies, this file explains.
export type DaemonRuntimeFile = {
  version: 1;
  pid: number;
  protocol: number;
  build: string;
  socketPath: string;
  startedAt: string;
};

export function writeRuntimeFile(path: string, info: DaemonRuntimeFile): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readRuntimeFile(path: string): DaemonRuntimeFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<DaemonRuntimeFile>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.protocol !== "number" ||
      typeof value.build !== "string" ||
      !value.build ||
      typeof value.socketPath !== "string" ||
      !value.socketPath ||
      typeof value.startedAt !== "string"
    ) {
      return null;
    }
    return value as DaemonRuntimeFile;
  } catch {
    return null;
  }
}

export function removeRuntimeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}
