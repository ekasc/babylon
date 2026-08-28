// Tracked-process model for the Agent-Aware Terminal.
//
// Babylon tracks processes rather than treating every terminal as an opaque
// shell. Each process carries command, cwd, owning session/agent, pid, ports,
// and lifecycle state. Pure functions keep the registry predictable and
// testable; the main process wires real spawns and PTYs around this model.

export type ProcessState = "starting" | "running" | "exited" | "failed" | "killed";

export interface TrackedProcess {
  id: string;
  command: string;
  cwd: string;
  /** Owning session/agent id, when the process was created by an agent. */
  ownerSession?: string;
  /** Human label for the owner, e.g. "Main Agent" or "Backend worker". */
  owner?: string;
  pid?: number;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
  state: ProcessState;
  detectedPorts: number[];
  /** Bounded combined stdout/stderr output (capped at 256 KiB). */
  output: string;
  /** True when oldest output was dropped due to the cap. */
  outputTruncated: boolean;
}

export interface ProcessRegistry {
  processes: Record<string, TrackedProcess>;
}

export function createRegistry(): ProcessRegistry {
  return { processes: {} };
}

export function createProcess(
  registry: ProcessRegistry,
  params: {
    id: string;
    command: string;
    cwd: string;
    ownerSession?: string;
    owner?: string;
    pid?: number;
    startedAt?: number;
    state?: ProcessState;
    output?: string;
    outputTruncated?: boolean;
    detectedPorts?: number[];
    exitedAt?: number;
    exitCode?: number;
  }
): ProcessRegistry {
  const proc: TrackedProcess = {
    id: params.id,
    command: params.command,
    cwd: params.cwd,
    ownerSession: params.ownerSession,
    owner: params.owner,
    pid: params.pid,
    startedAt: params.startedAt ?? 0,
    state: params.state ?? "starting",
    detectedPorts: params.detectedPorts ? [...params.detectedPorts].sort((a, b) => a - b) : [],
    output: params.output ?? "",
    outputTruncated: params.outputTruncated ?? false,
    exitedAt: params.exitedAt,
    exitCode: params.exitCode,
  };
  return { processes: { ...registry.processes, [params.id]: proc } };
}

export function updateProcess(
  registry: ProcessRegistry,
  id: string,
  patch: Partial<Omit<TrackedProcess, "id">>
): ProcessRegistry {
  const existing = registry.processes[id];
  if (!existing) return registry;
  return { processes: { ...registry.processes, [id]: { ...existing, ...patch } } };
}

/** Record ports a running process is listening on (deduped, sorted). */
export function detectPorts(registry: ProcessRegistry, id: string, ports: number[]): ProcessRegistry {
  const existing = registry.processes[id];
  if (!existing) return registry;
  const merged = Array.from(new Set([...existing.detectedPorts, ...ports])).sort((a, b) => a - b);
  return updateProcess(registry, id, { detectedPorts: merged });
}

/** Mark a process as no longer running; it stays in history with its exit info. */
export function terminateProcess(
  registry: ProcessRegistry,
  id: string,
  info: { exitedAt?: number; exitCode?: number; state?: "exited" | "failed" | "killed" }
): ProcessRegistry {
  return updateProcess(registry, id, {
    state: info.state ?? "exited",
    exitedAt: info.exitedAt ?? Date.now(),
    exitCode: info.exitCode,
  });
}

export function removeProcess(registry: ProcessRegistry, id: string): ProcessRegistry {
  const next = { ...registry.processes };
  delete next[id];
  return { processes: next };
}

export function listActive(registry: ProcessRegistry): TrackedProcess[] {
  return Object.values(registry.processes).filter(
    (p) => p.state === "running" || p.state === "starting"
  );
}

/** Exited/failed/killed processes, most-recently-exited first. */
export function listHistory(registry: ProcessRegistry): TrackedProcess[] {
  return Object.values(registry.processes)
    .filter((p) => p.state === "exited" || p.state === "failed" || p.state === "killed")
    .sort((a, b) => (b.exitedAt ?? 0) - (a.exitedAt ?? 0) || a.id.localeCompare(b.id));
}

export function listByOwner(registry: ProcessRegistry, ownerSession: string): TrackedProcess[] {
  return Object.values(registry.processes).filter((p) => p.ownerSession === ownerSession);
}
