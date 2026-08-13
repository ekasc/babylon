import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * JSONL client for `pi --mode rpc` (see pi docs/rpc.md).
 *
 * Protocol notes:
 * - Strict JSONL: split records on `\n` only; strip a trailing `\r`.
 * - Commands are written as `{"id": "<req-id>", ...}`; the matching response has
 *   `type: "response"` and the same `id`.
 * - Everything else on stdout is an agent event, re-emitted as "event".
 */
export class PiRpc extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private seq = 0;
  private pending = new Map<
    string,
    { resolve: (data: any) => void; reject: (err: Error) => void }
  >();
  exited = false;
  stderrTail = "";
  readonly cwd: string;

  constructor(bin: string, args: string[], cwd: string) {
    super();
    this.cwd = cwd;
    this.proc = spawn(bin, args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-8000);
    });
    this.proc.on("error", (err) => {
      this.failAll(new Error(`failed to start pi: ${err.message}`));
      this.emit("error", err);
    });
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      this.failAll(new Error(`pi exited (${code ?? signal})`));
      this.emit("exit", { code, signal });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;

      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON startup noise
      }

      if (obj?.type === "response" && typeof obj.id === "string" && this.pending.has(obj.id)) {
        const p = this.pending.get(obj.id)!;
        this.pending.delete(obj.id);
        if (obj.success) p.resolve(obj.data ?? null);
        else p.reject(new Error(obj.error || `command failed: ${obj.command}`));
      } else {
        this.emit("event", obj);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /** Send a command and wait for its response. Resolves with `response.data`. */
  send(command: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
    if (this.exited) return Promise.reject(new Error("pi process exited"));
    const id = `pideck-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for response to "${command.type}"`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.proc.stdin.write(JSON.stringify({ id, ...command }) + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Fire-and-forget write (e.g. extension_ui_response). */
  writeNoResponse(obj: Record<string, unknown>): void {
    if (!this.exited) this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Poll get_state until pi accepts commands (startup can take a moment). */
  async waitForReady(timeoutMs = 60_000): Promise<any> {
    const start = Date.now();
    let lastErr: Error | undefined;
    while (Date.now() - start < timeoutMs) {
      if (this.exited) break;
      try {
        return await this.send({ type: "get_state" }, 8_000);
      } catch (err) {
        lastErr = err as Error;
        if (this.exited) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw new Error(
      `pi did not become ready: ${lastErr?.message ?? "timeout"}${
        this.stderrTail ? `\n${this.stderrTail.slice(-2000)}` : ""
      }`
    );
  }

  kill(): void {
    if (this.exited) return;
    try {
      this.proc.kill("SIGTERM");
      const p = this.proc;
      setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 3_000).unref();
    } catch {
      /* already gone */
    }
  }
}
