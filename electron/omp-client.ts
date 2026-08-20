/**
 * OMP RPC client.
 *
 * Babylon drives Oh My Pi (OMP) through its first-class `omp --mode rpc`
 * subprocess: newline-delimited JSON over stdio. This avoids importing the
 * OMP SDK (it ships TypeScript source on Bun with native addons and cannot be
 * embedded in-process in a Node/Electron host). Every OMP type is treated as
 * `any` here on purpose — we speak the JSON wire protocol, not the package.
 *
 * Protocol (see OMP docs/rpc.md):
 *  - First stdout line is a `ready` frame advertising protocol versions.
 *  - We negotiate protocol v2 (lossless chunked oversized frames).
 *  - Commands are JSON objects with an `id`; matching `response` frames carry
 *    `success`/`data`/`error`.
 *  - Everything else on stdout is an `AgentSessionEvent` (or subagent frame)
 *    forwarded to the host for translation into Babylon's event stream.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export type OmpFrame = any;

export interface OmpRpcClientOptions {
  ompPath?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface PendingCommand {
  command: string;
  resolve: (data: any) => void;
  reject: (err: Error) => void;
}

export class OmpRpcClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private pending = new Map<string, PendingCommand>();
  private reassembly = new Map<string, { chunks: string[]; total: number; have: number }>();
  private stdoutBuf = "";
  private ready = false;
  private startResolve: (() => void) | null = null;
  private startReject: ((err: Error) => void) | null = null;
  private disposed = false;

  /** Session/agent events (AgentSessionEvent | RpcSubagentFrame). */
  onEvent: ((frame: OmpFrame) => void) | null = null;
  /** Process lifecycle status for Babylon's connection indicator. */
  onStatus: ((status: { status: string; [key: string]: unknown }) => void) | null = null;
  /** Stderr / error text. */
  onError: ((err: Error) => void) | null = null;

  constructor(private readonly opts: OmpRpcClientOptions = {}) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      const omp = this.opts.ompPath ?? "omp";
      const args = ["--mode", "rpc", ...(this.opts.args ?? [])];
      try {
        this.proc = spawn(omp, args, {
          cwd: this.opts.cwd,
          env: this.opts.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        reject(e as Error);
        return;
      }
      this.proc.on("error", (e) => {
        this.onError?.(e);
        this.startReject?.(e);
      });
      this.proc.stderr?.setEncoding("utf8").on("data", (d) => {
        const s = d.toString().trim();
        if (s) this.onError?.(new Error(s));
      });
      this.proc.stdout?.setEncoding("utf8").on("data", (d) => this.onStdout(d.toString()));
      this.proc.on("exit", (code) => {
        this.onStatus?.({ status: "exited", code });
        if (!this.ready) this.startReject?.(new Error(`omp exited with code ${code ?? -1}`));
      });
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let i: number;
    while ((i = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, i);
      this.stdoutBuf = this.stdoutBuf.slice(i + 1);
      const t = line.trim();
      if (!t) continue;
      let frame: OmpFrame;
      try {
        frame = JSON.parse(t);
      } catch {
        continue;
      }
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: OmpFrame): void {
    if (!frame || typeof frame !== "object") return;
    switch (frame.type) {
      case "ready":
        this.ready = true;
        // Negotiate v2 for lossless oversized-frame reassembly.
        this.send({ id: "negotiate", type: "negotiate_protocol", protocolVersion: 2 })
          .then(() => this.startResolve?.())
          .catch(() => this.startResolve?.());
        return;
      case "rpc_chunk":
        this.handleChunk(frame);
        return;
      case "response": {
        const id = frame.id as string | undefined;
        if (id) {
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            if (frame.success) p.resolve(frame.data);
            else p.reject(new Error(frame.error ?? `command ${frame.command} failed`));
          }
        }
        return;
      }
      default:
        this.onEvent?.(frame);
    }
  }

  private handleChunk(frame: any): void {
    const acc =
      this.reassembly.get(frame.chunkId) ??
      { chunks: new Array(frame.count), total: frame.count, have: 0 };
    acc.chunks[frame.index] = frame.data;
    acc.have++;
    if (acc.have === acc.total) {
      this.reassembly.delete(frame.chunkId);
      const json = Buffer.from(acc.chunks.join(""), "base64").toString("utf8");
      try {
        this.handleFrame(JSON.parse(json));
      } catch {
        /* ignore malformed reassembled frame */
      }
    } else {
      this.reassembly.set(frame.chunkId, acc);
    }
  }

  /** Send an RPC command; resolves with `data` on success, rejects on failure. */
  send(command: Record<string, unknown>): Promise<any> {
    if (this.disposed || !this.proc) return Promise.reject(new Error("omp rpc not started"));
    const id = `c${++this.seq}`;
    const msg = { ...command, id };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { command: String(command.type), resolve, reject });
      try {
        this.proc!.stdin.write(JSON.stringify(msg) + "\n");
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.proc?.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}
