/**
 * OMP host.
 *
 * Replaces Babylon's in-process PiHost with a process that drives Oh My Pi
 * (OMP) over the `omp --mode rpc` subprocess (see electron/omp-client.ts).
 *
 * The public surface intentionally mirrors the bits of PiHost that
 * electron/main.ts already calls, so the IPC wiring changes minimally:
 *   - core chat loop + model/thinking/state are implemented against OMP RPC;
 *   - pi-only features (session tree, rollback, fork/clone, worktrees,
 *     threads/subagents, workflows) are stubbed until ported slice by slice.
 *
 * Event translation: OMP is a pi fork, so its AgentSessionEvent stream already
 * matches Babylon's `applyEvent` contract (message_start/message_update/
 * message_end/tool_execution_*). The only rename is `agent_end` -> Babylon's
 * `agent_settled`, which clears the streaming flag.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { OmpRpcClient, type OmpFrame } from "./omp-client";
import { readToolOutput } from "./sessions";

export interface OmpHostOptions {
  cwd: string;
  ompPath?: string;
  args?: string[];
  onEvent: (event: any) => void;
  onStatus: (status: { status: string; [key: string]: unknown }) => void;
}

const DEFAULT_MODEL = process.env.BABYLON_OMP_MODEL || "opencode-go/hy3";
const OMP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// OMP's agent session file root (mirrors ~/.pi/agent/sessions for pi).
export const OMP_SESSIONS_ROOT = join(homedir(), ".omp", "agent", "sessions");

export class OmpHost {
  private client: OmpRpcClient;
  private state: any = null;
  activeSessionFile: string | undefined;

  constructor(private readonly options: OmpHostOptions) {
    this.client = new OmpRpcClient({
      ompPath: options.ompPath,
      args: [`--model`, DEFAULT_MODEL, ...(options.args ?? [])],
      cwd: options.cwd,
      env: process.env,
    });
    this.client.onEvent = (frame) => this.handleEvent(frame);
    this.client.onStatus = (s) => options.onStatus(s);
    this.client.onError = (e) => options.onStatus({ status: "error", message: e.message });
  }

  async start(): Promise<void> {
    await this.client.start();
    this.options.onStatus({ status: "ready", cwd: this.options.cwd });
  }

  private handleEvent(frame: OmpFrame): void {
    if (frame?.type === "agent_end") {
      // Babylon clears its streaming flag on `agent_settled`, not `agent_end`.
      this.options.onEvent({ type: "agent_settled" });
      return;
    }
    this.options.onEvent(frame);
  }

  // --- core chat loop -------------------------------------------------------

  async open(opts: { path?: string; cwd: string; requestId?: number }): Promise<void> {
    if (opts.path) {
      // Open an existing session: point OMP at its file.
      if (this.activeSessionFile && opts.path !== this.activeSessionFile) {
        try {
          await this.client.send({ type: "switch_session", sessionPath: opts.path });
        } catch {
          /* session may not exist yet; ignore */
        }
      }
    } else {
      // "New session": start a fresh OMP session for the current cwd rather
      // than continuing the previously-active one. OMP keys sessions by the
      // subprocess cwd, so this lands in the right project directory.
      try {
        await this.client.send({ type: "new_session" });
      } catch {
        /* engine may already be on a fresh session; ignore */
      }
    }
    await this.getState();
    this.options.onStatus({ status: "ready", cwd: opts.cwd });
  }

  prompt(message: string, images?: any[], streamingBehavior?: "steer" | "followUp"): Promise<any> {
    const type =
      streamingBehavior === "steer"
        ? "steer"
        : streamingBehavior === "followUp"
          ? "follow_up"
          : "prompt";
    return this.client.send({ type, message, images });
  }

  abort(): Promise<any> {
    return this.client.send({ type: "abort" });
  }

  async getState(): Promise<any> {
    this.state = await this.client.send({ type: "get_state" });
    this.activeSessionFile = this.state?.sessionFile;
    return this.state;
  }

  async getMessages(): Promise<any[]> {
    const r = await this.client.send({ type: "get_messages" });
    return r?.messages ?? [];
  }

  async getStats(): Promise<any> {
    try {
      return await this.client.send({ type: "get_session_stats" });
    } catch {
      return null;
    }
  }

  async getModels(): Promise<any[]> {
    const r = await this.client.send({ type: "get_available_models" });
    return (r?.models ?? []).map((m: any) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: !!m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
  }

  async getCommands(): Promise<any[]> {
    try {
      const r = await this.client.send({ type: "get_available_commands" });
      return (r?.commands ?? []).map((c: any) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.input?.hint,
        // Babylon's palette groups by `source`; OMP reports "builtin" (and
        // skill:/plugin: names), so normalize to Babylon's three buckets.
        source: c.name.startsWith("skill:")
          ? "skill"
          : c.name === "marketplace" || c.name.startsWith("plugin")
            ? "extension"
            : "prompt",
      }));
    } catch {
      return [];
    }
  }

  setModel(provider: string, modelId: string): Promise<any> {
    return this.client.send({ type: "set_model", provider, modelId });
  }

  getThinkingLevel(): string | undefined {
    return this.state?.thinkingLevel;
  }

  getThinkingLevels(): Promise<string[]> {
    return Promise.resolve(OMP_THINKING_LEVELS);
  }

  setThinking(level: string): Promise<any> {
    return this.client.send({ type: "set_thinking_level", level });
  }

  setSessionName(name: string): Promise<any> {
    return this.client.send({ type: "set_session_name", name });
  }

  compact(): Promise<any> {
    return this.client.send({ type: "compact" });
  }

  async getToolOutput(toolCallId: string): Promise<{ content: string; truncated: boolean }> {
    if (!this.activeSessionFile) return { content: "", truncated: false };
    try {
      return await readToolOutput(this.activeSessionFile, toolCallId);
    } catch {
      return { content: "", truncated: false };
    }
  }

  async getRecaps(_path: string): Promise<any[]> {
    return [];
  }

  async refreshFromDisk(_path: string): Promise<boolean> {
    return true;
  }

  respondUi(_id: string, _resp: Record<string, unknown>): void {
    // TODO: map to OMP's extension_ui_response when wired.
  }

  notifyThreadEvent(_thread: any, _event: any): void {}

  // --- pi-only features: stubbed until ported -------------------------------

  async getTree(): Promise<any> {
    return { rows: [], leafId: null };
  }
  async getHistory(): Promise<any> {
    return { turns: [], leafId: null, hasBranches: false };
  }
  async prepareRollback(_entryId: string): Promise<any> {
    throw new Error("rollback is not implemented for OMP yet");
  }
  async commitRollback(_planId: string): Promise<any> {
    throw new Error("rollback is not implemented for OMP yet");
  }
  async undoRollback(): Promise<any> {
    throw new Error("rollback is not implemented for OMP yet");
  }
  async getForkMessages(): Promise<any[]> {
    return [];
  }
  async fork(_entryId: string): Promise<any> {
    return { cancelled: true };
  }
  async clone(): Promise<any> {
    return { cancelled: true };
  }
  async switchTo(_path: string): Promise<void> {
    await this.client.send({ type: "switch_session", sessionPath: _path });
  }
  controlThread(_action: any, _threadId?: string, _message?: string): Promise<any> {
    throw new Error("threads are not implemented for OMP yet");
  }
  promoteThread(_threadId?: string): Promise<any> {
    throw new Error("threads are not implemented for OMP yet");
  }
  controlSubagent(_action: any, _runId?: string, _message?: string): Promise<any> {
    throw new Error("subagents are not implemented for OMP yet");
  }
  promoteSubagent(_runId?: string): Promise<any> {
    throw new Error("subagents are not implemented for OMP yet");
  }

  dispose(): void {
    this.client.dispose();
  }
}
