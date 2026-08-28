import { ChildProcess, spawn as defaultSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const OUTPUT_CAP = 256 * 1024;
export const COMMAND_MAX = 8192;
export const CWD_MAX = 4096;
export const ID_MAX = 200;
export const KILL_GRACE_MS = 2000;

export type ProcessState = "starting" | "running" | "exited" | "failed" | "killed";

export interface ProcessSnapshot {
  id: string;
  command: string;
  cwd: string;
  owner?: string;
  ownerSession?: string;
  pid?: number;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
  state: ProcessState;
  detectedPorts: number[];
  output: string;
  outputTruncated: boolean;
}

type SpawnFn = (
  command: string,
  options: { cwd: string; shell: boolean; detached: boolean },
) => ChildProcess;

interface InternalEntry {
  snapshot: ProcessSnapshot;
  child: ChildProcess | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  killRequested: boolean;
}

export function validateCommand(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid command");
  if (value.length === 0 || value.length > COMMAND_MAX) throw new Error("invalid command");
  if (value.includes("\0")) throw new Error("invalid command");
  if (value.trim().length === 0) throw new Error("invalid command");
  return value;
}

export function validateCwd(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid cwd");
  if (value.length === 0 || value.length > CWD_MAX) throw new Error("invalid cwd");
  if (value.includes("\0")) throw new Error("invalid cwd");
  if (!isAbsolute(value)) throw new Error("invalid cwd");
  if (!existsSync(value)) throw new Error("invalid cwd");
  try {
    const st = statSync(value);
    if (!st.isDirectory()) throw new Error("invalid cwd");
  } catch (e) {
    if ((e as Error).message === "invalid cwd") throw e;
    throw new Error("invalid cwd");
  }
  return value;
}

export function validateId(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid id");
  if (value.length === 0 || value.length > ID_MAX) throw new Error("invalid id");
  if (value.includes("\0")) throw new Error("invalid id");
  // Conservative: allow UUID-like and simple ids
  if (value.includes("/") || value.includes("\\")) throw new Error("invalid id");
  return value;
}

export function detectPortsFromOutput(text: string): number[] {
  const ports = new Set<number>();
  const add = (v: string) => {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) ports.add(n);
  };

  // localhost:3000, 127.0.0.1:3000, 0.0.0.0:3000
  for (const m of text.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\s*:\s*(\d{2,5})/gi)) {
    add(m[1]);
  }
  // http://host:port and https://
  for (const m of text.matchAll(/https?:\/\/[^\s/]+:\s*(\d{2,5})\b/gi)) {
    add(m[1]);
  }
  // listening on :port or listening on port port or listening on localhost:port
  for (const m of text.matchAll(/listening\s+on[^\n]{0,120}?[:\s](\d{2,5})\b/gi)) {
    add(m[1]);
  }
  // "port 3000" or "port: 3000" when preceded by listening/running/started/server
  for (const m of text.matchAll(/(?:listening|running|started|server|app)\s+[^.\n]{0,40}?\bport\s*[:=]?\s*(\d{2,5})\b/gi)) {
    add(m[1]);
  }

  return [...ports].sort((a, b) => a - b);
}

function capOutput(
  current: string,
  chunk: string,
  cap: number,
  alreadyTruncated: boolean,
): { output: string; truncated: boolean } {
  const combined = current + chunk;
  const len = Buffer.byteLength(combined, "utf8");
  if (len <= cap) return { output: combined, truncated: alreadyTruncated };
  // Need to drop oldest bytes. Slice buffer tail.
  const buf = Buffer.from(combined, "utf8");
  const tail = buf.slice(buf.length - cap);
  return { output: tail.toString("utf8"), truncated: true };
}

export class ProcessManager {
  private entries = new Map<string, InternalEntry>();
  private listeners = new Set<(snapshots: ProcessSnapshot[]) => void>();
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly outputCap: number;
  private readonly killGraceMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly nowFn: () => number;
  private readonly detachedSupported: boolean;

  constructor(opts?: {
    outputCap?: number;
    killGraceMs?: number;
    spawnFn?: SpawnFn;
    nowFn?: () => number;
    detachedSupported?: boolean;
  }) {
    this.outputCap = opts?.outputCap ?? OUTPUT_CAP;
    this.killGraceMs = opts?.killGraceMs ?? KILL_GRACE_MS;
    this.spawnFn =
      (opts?.spawnFn as SpawnFn) ??
      ((command: string, options: { cwd: string; shell: boolean; detached: boolean }) =>
        defaultSpawn(command, {
          cwd: options.cwd,
          shell: true,
          detached: options.detached,
          stdio: "pipe",
        } as unknown as Parameters<typeof defaultSpawn>[1]) as ChildProcess);
    this.nowFn = opts?.nowFn ?? (() => Date.now());
    this.detachedSupported = opts?.detachedSupported ?? process.platform !== "win32";
  }

  subscribe(listener: (snapshots: ProcessSnapshot[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): ProcessSnapshot[] {
    return [...this.entries.values()].map((e) => ({ ...e.snapshot }));
  }

  get(id: string): ProcessSnapshot | undefined {
    const e = this.entries.get(id);
    return e ? { ...e.snapshot } : undefined;
  }

  listByOwner(owner: string): ProcessSnapshot[] {
    return this.list().filter((process) => process.owner === owner);
  }

  async killByOwner(owner: string): Promise<ProcessSnapshot[]> {
    const owned = this.listByOwner(owner);
    const active = owned.filter((process) => process.state === "running" || process.state === "starting");
    for (const process of active) this.kill(process.id);
    await Promise.all(active.map((process) => this.waitForTerminalState(process.id)));
    return this.listByOwner(owner);
  }

  spawn(params: { command: string; cwd: string; owner?: string; ownerSession?: string }): ProcessSnapshot {
    const command = validateCommand(params.command);
    const cwd = validateCwd(params.cwd);
    const owner = params.owner && typeof params.owner === "string" && params.owner.length <= 500 ? params.owner : undefined;
    const ownerSession =
      params.ownerSession && typeof params.ownerSession === "string" && params.ownerSession.length <= 500
        ? params.ownerSession
        : undefined;

    const id = randomUUID();
    const startedAt = this.nowFn();
    const snapshot: ProcessSnapshot = {
      id,
      command,
      cwd,
      owner,
      ownerSession,
      startedAt,
      state: "starting",
      detectedPorts: [],
      output: "",
      outputTruncated: false,
    };
    const entry: InternalEntry = { snapshot, child: null, killTimer: null, killRequested: false };
    this.entries.set(id, entry);
    this.broadcastNow();

    // Attempt spawn
    try {
      const child = this.spawnFn(command, {
        cwd,
        shell: true,
        detached: this.detachedSupported,
      });

      entry.child = child as ChildProcess;

      // If pid is available, transition to running
      const pid = (child as { pid?: number }).pid;
      if (typeof pid === "number" && Number.isFinite(pid)) {
        entry.snapshot = { ...entry.snapshot, pid, state: "running" };
        this.broadcastNow();
      } else {
        entry.snapshot = { ...entry.snapshot, state: "running" };
        this.broadcastNow();
      }

      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        this.appendOutput(id, text);
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.on("error", (err: Error) => {
        const cur = this.entries.get(id);
        if (!cur) return;
        // Spawn error becomes failed snapshot
        const appended = capOutput(cur.snapshot.output, `\n[spawn error] ${err.message}\n`, this.outputCap, cur.snapshot.outputTruncated);
        cur.snapshot = {
          ...cur.snapshot,
          ...appended,
          state: "failed",
          exitedAt: this.nowFn(),
        };
        cur.child = null;
        this.clearKillTimer(cur);
        this.broadcastNow();
      });

      child.on("close", (code: number | null, signal: string | null) => {
        const cur = this.entries.get(id);
        if (!cur) return;
        // 'close' fires after stdio closed; ensure we only transition once
        if (cur.snapshot.state !== "running" && cur.snapshot.state !== "starting") return;
        this.clearKillTimer(cur);
        const exitedAt = this.nowFn();
        let state: ProcessState;
        let exitCode: number | undefined;
        if (cur.killRequested) {
          state = "killed";
          exitCode = code ?? undefined;
        } else if (signal) {
          state = "failed";
          exitCode = code ?? undefined;
        } else if (typeof code === "number") {
          if (code === 0) {
            state = "exited";
            exitCode = 0;
          } else {
            state = "failed";
            exitCode = code;
          }
        } else {
          state = "failed";
        }
        cur.snapshot = {
          ...cur.snapshot,
          state,
          exitCode,
          exitedAt,
        };
        cur.child = null;
        this.broadcastNow();
      });

      // Also listen to exit as fallback if close not fired
      child.on("exit", (code: number | null, signal: string | null) => {
        const cur = this.entries.get(id);
        if (!cur) return;
        if (cur.snapshot.state !== "running" && cur.snapshot.state !== "starting") return;
        // If close will follow, let close handle it; but schedule a fallback broadcast
        // Defer to close; if close never fires, handle here after short delay.
        // We'll not duplicate if close already handled.
        // No-op here; close is authoritative.
        void code;
        void signal;
      });

      // Handle spawn failure that throws synchronously (already in try/catch)
      // child.pid may be undefined if spawn failed
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const appended = capOutput(snapshot.output, `\n[spawn error] ${message}\n`, this.outputCap, snapshot.outputTruncated);
      entry.snapshot = {
        ...entry.snapshot,
        ...appended,
        state: "failed",
        exitedAt: this.nowFn(),
        exitCode: undefined,
      };
      this.broadcastNow();
    }

    return { ...this.entries.get(id)!.snapshot };
  }

  kill(id: string): ProcessSnapshot {
    const validated = validateId(id);
    const entry = this.entries.get(validated);
    if (!entry) throw new Error("unknown process");
    // Idempotent: if already exited/failed/killed, return current
    if (entry.snapshot.state !== "running" && entry.snapshot.state !== "starting") {
      return { ...entry.snapshot };
    }
    // If already requested kill, idempotent
    if (entry.killRequested) {
      return { ...entry.snapshot };
    }
    entry.killRequested = true;
    const child = entry.child;
    const pid = entry.snapshot.pid;

    const send = (signal: NodeJS.Signals) => {
      if (!child) return;
      try {
        if (this.detachedSupported && typeof pid === "number" && pid > 0) {
          try {
            process.kill(-pid, signal);
            return;
          } catch {
            // fallback to child handle
          }
        }
        // Windows or fallback: use child handle
        try {
          (child as unknown as { kill: (s: string) => boolean }).kill(signal);
        } catch {
          /* ignore */
        }
      } catch {
        /* ignore */
      }
    };

    send("SIGTERM");
    // Schedule SIGKILL fallback
    if (entry.killTimer) clearTimeout(entry.killTimer);
    entry.killTimer = setTimeout(() => {
      const cur = this.entries.get(validated);
      if (!cur) return;
      if (cur.snapshot.state === "running" || cur.snapshot.state === "starting") {
        send("SIGKILL");
        // Give a brief extra grace to mark killed if signal doesn't lead to exit event
        setTimeout(() => {
          const again = this.entries.get(validated);
          if (!again) return;
          if (again.snapshot.state === "running" || again.snapshot.state === "starting") {
            again.snapshot = {
              ...again.snapshot,
              state: "killed",
              exitedAt: this.nowFn(),
            };
            again.child = null;
            this.clearKillTimer(again);
            this.broadcastNow();
          }
        }, 500);
      }
    }, this.killGraceMs);
    // Do not change state immediately; wait for exit. But broadcast to signal kill was requested? No.
    // Still broadcast to allow UI to reflect pending kill? Spec says history shows actual final state, not interim.
    // We keep current snapshot until exit.
    return { ...entry.snapshot };
  }

  dispose(): void {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    for (const [id, entry] of this.entries) {
      if (entry.snapshot.state === "running" || entry.snapshot.state === "starting") {
        try {
          this.kill(id);
        } catch {
          /* ignore */
        }
        // For dispose, force SIGKILL quickly if still alive after grace
        // We attempt immediate SIGKILL after TERM already sent
      }
      if (entry.killTimer) {
        clearTimeout(entry.killTimer);
        entry.killTimer = null;
      }
      // Also ensure child is killed even if not tracked via kill (fallback)
      if (entry.child) {
        try {
          const pid = entry.snapshot.pid;
          if (this.detachedSupported && typeof pid === "number" && pid > 0) {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              try {
                (entry.child as unknown as { kill: (s: string) => boolean }).kill("SIGKILL");
              } catch {}
            }
          } else {
            try {
              (entry.child as unknown as { kill: (s: string) => boolean }).kill("SIGKILL");
            } catch {}
          }
        } catch {}
      }
    }
    // Give a brief moment for OS to reap? Not waiting; best effort.
  }

  private appendOutput(id: string, chunk: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const prev = entry.snapshot;
    const capped = capOutput(prev.output, chunk, this.outputCap, prev.outputTruncated);
    const newPorts = detectPortsFromOutput(capped.output);
    const mergedPorts = [...new Set([...prev.detectedPorts, ...newPorts])].sort((a, b) => a - b);
    const portsChanged = mergedPorts.length !== prev.detectedPorts.length || mergedPorts.some((p, i) => p !== prev.detectedPorts[i]);
    if (capped.output !== prev.output || capped.truncated !== prev.outputTruncated || portsChanged) {
      entry.snapshot = {
        ...prev,
        output: capped.output,
        outputTruncated: capped.truncated,
        detectedPorts: mergedPorts,
      };
      this.scheduleBroadcast();
    }
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcastNow();
    }, 32);
  }

  private broadcastNow(): void {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    const snapshots = this.list();
    for (const l of this.listeners) {
      try {
        l(snapshots);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  private waitForTerminalState(id: string): Promise<void> {
    const timeoutMs = this.killGraceMs + 1000;
    return new Promise((resolve, reject) => {
      const startedAt = this.nowFn();
      const check = () => {
        const process = this.entries.get(id)?.snapshot;
        if (!process || (process.state !== "running" && process.state !== "starting")) {
          resolve();
          return;
        }
        if (this.nowFn() - startedAt >= timeoutMs) {
          reject(new Error(`timed out stopping process ${id}`));
          return;
        }
        setTimeout(check, 25);
      };
      check();
    });
  }

  private clearKillTimer(entry: InternalEntry): void {
    if (entry.killTimer) {
      clearTimeout(entry.killTimer);
      entry.killTimer = null;
    }
  }
}
