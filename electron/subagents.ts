import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type AgentSession,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { installPermissionHook } from "./permission-hook";
import type { BabylonPermissionController } from "./permissions";

export type SubagentDelivery = "steer" | "follow-up";
export type SubagentControlAction = SubagentDelivery | "stop";
export type SubagentParentEvent = SubagentControlAction | "reply";
export type ManagedSubagentStatus = "starting" | "running" | "idle" | "failed" | "stopped" | "interrupted";

export interface ManagedSubagentRecord {
  version: 1;
  runId: string;
  name: string | null;
  task: string;
  cwd: string;
  status: ManagedSubagentStatus;
  requestedModel: string;
  sessionModel: string;
  profile: "read-only" | "verify" | "write";
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Persistent agents keep a goal across turns (thread-equivalent mode). */
  persistent?: boolean;
  goal?: string | null;
  milestones?: Array<{ at: string; name: string; note?: string }>;
  sessionFile: string | null;
  parentSessionId: string | null;
  parentSessionFile: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  output: string | null;
  error: string | null;
  latestActivity: string | null;
  recentMessages: Array<{ at: string; role: "user" | "assistant" | "activity" | "status"; text: string }>;
  revision: number;
}

interface ManagedRuntime {
  record: ManagedSubagentRecord;
  session: AgentSession;
  running: Promise<void> | null;
  unsubscribe: (() => void) | null;
  timeout: NodeJS.Timeout | null;
}

interface SubagentParams {
  task: string;
  model?: string;
  profile?: ManagedSubagentRecord["profile"];
  thinking?: ManagedSubagentRecord["thinking"];
  timeoutMs?: number;
  name?: string;
  /** Persistent agents keep pursuing the goal across follow-up turns. */
  persistent?: boolean;
  goal?: string;
}

const PROFILE_TOOLS: Record<ManagedSubagentRecord["profile"], string[]> = {
  "read-only": ["read", "grep", "find", "ls"],
  verify: ["read", "grep", "find", "ls", "bash"],
  write: ["read", "grep", "find", "ls", "bash", "edit", "write"],
};
const ID = /^[a-f0-9-]{20,}$/i;
const MAX_MESSAGE = 24_000;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => typeof part === "string" ? part : part?.text ?? part?.thinking ?? "").join("");
}

function exactModel(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function splitModel(ref: string): [string, string] {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) throw new Error("Subagent model must be provider/model");
  return [ref.slice(0, slash), ref.slice(slash + 1)];
}

function runDir(cwd: string, runId: string): string {
  if (!ID.test(runId)) throw new Error("Invalid subagent run id");
  return join(cwd, ".pi", "state", "subagents", "runs", runId);
}

function recordPath(cwd: string, runId: string): string {
  return join(runDir(cwd, runId), "run.json");
}

export class ManagedSubagents {
  private runtimes = new Map<string, ManagedRuntime>();

  constructor(
    private readonly options: {
      agentDir: string;
      modelRuntime: ModelRuntime;
      onUpdate?: () => void;
      onParentMessage?: (record: ManagedSubagentRecord, action: SubagentParentEvent, message?: string) => void | Promise<void>;
      /** Babylon permission controller, if enabled. Gates the subagent's tools. */
      permission?: BabylonPermissionController;
      onLaunch?: (ev: { type: "babylon_launch_started" | "babylon_launch_terminated"; runId: string; runKind: "subagent" | "thread" | "workflow"; label?: string; status?: string }) => void;
    }
  ) {
    void this.recoverPersistent();
  }

  tool(): ToolDefinition<any, any> {
    return {
      name: "subagent",
      label: "Subagent",
      description: "Run an isolated Pi child session that remains available for live steering and follow-up messages from Babylon.",
      promptSnippet: "Delegate a bounded task to a steerable isolated child session",
      promptGuidelines: [
        "Use subagent for narrow independent work and retain the returned runId for steering or follow-up messages.",
        "Use read-only for inspection, verify for tests, and write only for a bounded implementation task.",
        "For long-running, multi-turn work set persistent: true and give a goal; the agent keeps pursuing it across follow-ups and reports milestones.",
      ],
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["task"],
        properties: {
          task: { type: "string", minLength: 1, description: "A narrow, self-contained task for the child agent." },
          model: { type: "string", description: "Exact provider/model identifier. Defaults to the parent model." },
          profile: { type: "string", enum: ["read-only", "verify", "write"] },
          thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh"] },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 3_600_000 },
          name: { type: "string" },
          persistent: { type: "boolean", description: "Keep pursuing a goal across follow-up turns (multi-turn agent, like a thread)." },
          goal: { type: "string", description: "Standing goal for persistent agents; defaults to the task." },
        },
      } as any,
      execute: async (_toolCallId, raw, signal, onUpdate, ctx) => {
        try {
          const runtime = await this.create(raw as SubagentParams, ctx);
          onUpdate?.({
            content: [{ type: "text", text: `Subagent ${runtime.record.runId} started. It can receive steer and follow-up messages from Activity.` }],
            details: { runId: runtime.record.runId, status: "running", controllable: true },
          });
          const abort = () => void this.stopRuntime(runtime, "cancelled by parent");
          signal?.addEventListener("abort", abort, { once: true });
          await runtime.running;
          signal?.removeEventListener("abort", abort);
          const record = runtime.record;
          const summary = [
            `[subagent ${record.status}] ${record.name ?? record.runId}`,
            `Run: ${record.runId}`,
            `Model: ${record.sessionModel}`,
            `Profile: ${record.profile}; thinking: ${record.thinking}`,
            "",
            record.output?.trim() || record.error || "(no child output)",
          ].join("\n");
          return {
            content: [{ type: "text", text: summary }],
            details: {
              runId: record.runId,
              status: record.status,
              requestedModel: record.requestedModel,
              primaryModel: record.sessionModel,
              profile: record.profile,
              thinking: record.thinking,
              controllable: record.status !== "stopped",
              sessionFile: record.sessionFile,
              stderr: record.error ?? "",
            },
            isError: record.status === "failed",
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            details: { status: "failed" },
            isError: true,
          };
        }
      },
    } as ToolDefinition<any, any>;
  }

  async control(cwd: string, action: SubagentControlAction, runId: string, message?: string): Promise<ManagedSubagentRecord> {
    if (!ID.test(runId)) throw new Error("Invalid subagent run id");
    const persisted = await this.readRecord(cwd, runId);
    if (!persisted) throw new Error("Subagent run not found");
    const live = this.runtimes.get(runId);
    const record = live?.record ?? persisted;
    if (action === "stop") {
      if (!live) {
        record.status = "stopped";
        record.completedAt = new Date().toISOString();
        record.latestActivity = "stopped from Babylon";
        this.addMessage(record, "status", record.latestActivity);
        await this.save(record);
        await this.options.onParentMessage?.(record, action);
        return record;
      }
      await this.stopRuntime(live, "stopped from Babylon");
      await this.options.onParentMessage?.(live.record, action);
      return live.record;
    }
    const text = message?.trim();
    if (!text) throw new Error("Message is required");
    if (record.status === "stopped") throw new Error("This subagent was stopped and is read-only");
    const runtime = live ?? await this.ensureRuntime(record);
    this.addMessage(runtime.record, "user", text);
    if (runtime.running) {
      if (action === "steer") {
        await runtime.session.steer(`[Parent Steering]\n${text}`);
        runtime.record.latestActivity = "Steering message queued";
      } else {
        await runtime.session.followUp(`[Parent Follow-Up]\n${text}`);
        runtime.record.latestActivity = "Follow-up queued";
      }
      await this.save(runtime.record);
    } else {
      void this.runTurn(runtime, action === "steer" ? `[Parent Steering]\n${text}` : `[Parent Follow-Up]\n${text}`);
    }
    await this.options.onParentMessage?.(runtime.record, action, text);
    return runtime.record;
  }

  async promote(cwd: string, runId: string): Promise<{ sessionFile: string; cwd: string; parentSessionFile: string | null }> {
    if (!ID.test(runId)) throw new Error("Invalid subagent run id");
    const persisted = await this.readRecord(cwd, runId);
    if (!persisted) throw new Error("Subagent run not found");
    const runtime = this.runtimes.get(runId);
    if (runtime?.running) throw new Error("Stop or wait for the subagent turn before opening it as the main session");
    const record = runtime?.record ?? persisted;
    if (!record.sessionFile) throw new Error("This subagent has no persisted session to open");
    await fs.access(record.sessionFile).catch(() => { throw new Error("The subagent session file no longer exists"); });
    const supervision = [
      `[Babylon Supervision] You are still subagent ${record.name ?? record.runId}, supervised by parent session ${record.parentSessionId ?? "unknown"}.`,
      "Do not claim to be the parent/main agent. Replies in this promoted conversation remain subagent replies and Babylon relays them to the parent conversation.",
    ].join("\n");
    if (runtime) {
      await runtime.session.sendCustomMessage({
        customType: "babylon_subagent_identity",
        content: supervision,
        display: true,
        details: { runId: record.runId, name: record.name, parentSessionId: record.parentSessionId, parentSessionFile: record.parentSessionFile },
      });
      runtime.unsubscribe?.();
      runtime.unsubscribe = null;
      runtime.session.dispose();
      this.runtimes.delete(runId);
    } else {
      SessionManager.open(record.sessionFile, undefined, record.cwd).appendCustomMessageEntry(
        "babylon_subagent_identity",
        supervision,
        true,
        { runId: record.runId, name: record.name, parentSessionId: record.parentSessionId, parentSessionFile: record.parentSessionFile }
      );
    }
    record.status = "stopped";
    record.completedAt ??= new Date().toISOString();
    record.latestActivity = "Opened as main session";
    this.addMessage(record, "status", record.latestActivity);
    await this.save(record);
    return { sessionFile: record.sessionFile, cwd: record.cwd, parentSessionFile: record.parentSessionFile };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(async (runtime) => {
      const wasRunning = Boolean(runtime.running);
      if (runtime.running) {
        await runtime.session.abort().catch(() => undefined);
        await runtime.running.catch(() => undefined);
        if (wasRunning && runtime.record.status !== "stopped") {
          runtime.record.status = "interrupted";
          runtime.record.error = "Babylon closed during an active turn; send a follow-up to resume";
          runtime.record.latestActivity = "Interrupted by application shutdown";
          await this.save(runtime.record).catch(() => undefined);
        }
      }
      runtime.unsubscribe?.();
      runtime.session.dispose();
    }));
    this.runtimes.clear();
  }

  private async create(params: SubagentParams, ctx: ExtensionContext): Promise<ManagedRuntime> {
    const task = params.task?.trim();
    if (!task) throw new Error("Subagent task is required");
    const requestedModel = params.model?.trim() || (ctx.model ? exactModel(ctx.model) : "");
    if (!requestedModel) throw new Error("No subagent model selected");
    const [provider, modelId] = splitModel(requestedModel);
    const model = this.options.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Subagent model not found: ${requestedModel}`);
    const profile = params.profile ?? "read-only";
    const thinking = params.thinking ?? "high";
    const persistent = params.persistent === true;
    const goal = persistent ? (params.goal?.trim() || task) : null;
    const runId = randomUUID();
    const now = new Date().toISOString();
    const record: ManagedSubagentRecord = {
      version: 1,
      runId,
      name: params.name?.trim() || null,
      task,
      cwd: ctx.cwd,
      status: "starting",
      requestedModel,
      sessionModel: exactModel(model),
      profile,
      thinking,
      persistent,
      goal,
      milestones: [],
      sessionFile: null,
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      output: null,
      error: null,
      latestActivity: "Creating isolated session",
      recentMessages: [],
      revision: 0,
    };
    this.addMessage(record, "user", task);
    const runtime = await this.createRuntime(record);
    this.runtimes.set(runId, runtime);
    this.options.onLaunch?.({ type: "babylon_launch_started", runId, runKind: "subagent", label: record.name ?? task.slice(0, 80), status: "running" });
    void this.runTurn(runtime, task, params.timeoutMs);
    return runtime;
  }

  private async ensureRuntime(record: ManagedSubagentRecord): Promise<ManagedRuntime> {
    const live = this.runtimes.get(record.runId);
    if (live) return live;
    const runtime = await this.createRuntime(record);
    this.runtimes.set(record.runId, runtime);
    return runtime;
  }

  /** Custom tool available inside persistent subagent sessions: the agent
   *  reports a milestone checkpoint toward its goal, mirroring threads. */
  milestoneTool(): ToolDefinition<any, any> {
    return {
      name: "report_milestone",
      label: "Report Milestone",
      description: "Report a milestone checkpoint toward your standing goal. Call this when you complete a meaningful, verifiable unit of work (a plan, a compiling change, passing tests). The parent is notified at checkpoints.",
      promptSnippet: "Report a milestone toward the goal",
      promptGuidelines: [
        "Call report_milestone at each meaningful, verifiable checkpoint toward the goal.",
        "Keep notes short and evidence-based (files, tests, commands).",
      ],
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80, description: "Short milestone name." },
          note: { type: "string", maxLength: 2000, description: "Optional evidence note." },
        },
      } as any,
      execute: async (_toolCallId: string, raw: any, _signal, _onUpdate, ctx: any) => {
        const sessionId = ctx.sessionManager?.getSessionId?.();
        const runtime = sessionId
          ? [...this.runtimes.values()].find((r) => r.session.sessionId === sessionId)
          : undefined;
        if (!runtime?.record.persistent) {
          return {
            content: [{ type: "text", text: "report_milestone is only available inside a persistent agent session." }],
            details: { error: true },
            isError: true,
          };
        }
        const record = runtime.record;
        (record.milestones ??= []).push({
          at: new Date().toISOString(),
          name: String(raw?.name ?? "").slice(0, 80),
          note: raw?.note ? String(raw.note).slice(0, 2000) : undefined,
        });
        await this.save(record);
        return {
          content: [{ type: "text", text: `Milestone reported: ${raw?.name}.` }],
          details: { milestone: raw?.name },
        };
      },
    };
  }

  /** After a process restart, no subagent runtime survives. Persistent agents
   *  keep their session file, so mark stale "running"/"starting" records as
   *  interrupted — the parent can resume them from Activity (follow-ups
   *  re-create the runtime from the persisted session). */
  async recoverPersistent(): Promise<void> {
    const roots = await fs.readdir(join(this.options.agentDir, "state", "subagents", "runs")).catch(() => []);
    await Promise.all(
      roots.map(async (runId) => {
        if (!/^[a-f0-9-]{20,}$/i.test(runId)) return;
        const recordPath = join(this.options.agentDir, "state", "subagents", "runs", runId, "run.json");
        try {
          const parsed = JSON.parse(await fs.readFile(recordPath, "utf8")) as ManagedSubagentRecord;
          if (parsed?.persistent && (parsed.status === "running" || parsed.status === "starting")) {
            parsed.status = "interrupted";
            parsed.latestActivity = "Interrupted by restart — continue from Activity";
            parsed.updatedAt = new Date().toISOString();
            await this.save(parsed);
          }
        } catch {
          /* malformed or gone */
        }
      })
    );
  }

  private async createRuntime(record: ManagedSubagentRecord): Promise<ManagedRuntime> {
    const [provider, modelId] = splitModel(record.sessionModel);
    const model = this.options.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Subagent model is no longer available: ${record.sessionModel}`);
    await fs.mkdir(runDir(record.cwd, record.runId), { recursive: true });
    let manager: SessionManager;
    if (record.sessionFile) {
      try {
        await fs.access(record.sessionFile);
        manager = SessionManager.open(record.sessionFile, join(runDir(record.cwd, record.runId), "sessions"), record.cwd);
      } catch {
        record.sessionFile = null;
        manager = SessionManager.create(record.cwd, join(runDir(record.cwd, record.runId), "sessions"));
      }
    } else {
      manager = SessionManager.create(record.cwd, join(runDir(record.cwd, record.runId), "sessions"));
    }
    const settingsManager = SettingsManager.create(record.cwd, this.options.agentDir, { projectTrusted: true });
    const services = await createAgentSessionServices({
      cwd: record.cwd,
      agentDir: this.options.agentDir,
      settingsManager,
      modelRuntime: this.options.modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        appendSystemPrompt: [
          `You are a supervised subagent, run ${record.runId}. Your parent session is ${record.parentSessionId ?? "unknown"}.`,
          ...(record.persistent
            ? [`You are a persistent agent with a standing goal: ${record.goal ?? record.task}. Keep pursuing this goal across every turn; parent follow-ups continue the mission, not new side-tasks.`]
            : []),
          "Messages prefixed [Parent Steering] or [Parent Follow-Up] were sent by your parent through Babylon Activity. Never claim that you are the main agent.",
          "You cannot directly inspect or message the parent session. Reply in this conversation; Babylon records the exchange for the parent.",
          "Do not spawn workflows, threads, or subagents.",
          record.profile === "write"
            ? "Work only within the assigned task and report all changes."
            : record.profile === "verify"
              ? "Inspect and run verification commands, but do not modify source files."
              : "Inspect and report only. Do not modify files or run shell commands.",
          "Parent steering and follow-up messages are authoritative.",
        ],
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      model,
      thinkingLevel: record.thinking as any,
      tools: PROFILE_TOOLS[record.profile],
      customTools: record.persistent ? [this.milestoneTool()] : undefined,
      excludeTools: ["subagent", "workflow", "spawn_thread", "send_input"] as any,
    });
    // Gate the subagent's tool calls through the same Babylon permission policy
    // as the parent session, so isolated agents can't bypass it.
    if (this.options.permission) {
      installPermissionHook(created.session.agent, this.options.permission, record.cwd);
    }
    const runtime: ManagedRuntime = { record, session: created.session, running: null, unsubscribe: null, timeout: null };
    record.sessionFile = created.session.sessionFile ?? manager.getSessionFile() ?? null;
    runtime.unsubscribe = created.session.subscribe((event: any) => {
      if (event.type === "tool_execution_start") {
        const suffix = event.args?.path ?? event.args?.command ?? "";
        record.latestActivity = `${event.toolName}${suffix ? ` ${suffix}` : ""}`.slice(0, 1000);
        this.addMessage(record, "activity", record.latestActivity);
        void this.save(record);
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = textOf(event.message.content).trim();
        if (text) {
          record.output = text.slice(-1_048_576);
          this.addMessage(record, "assistant", text);
          void this.save(record);
          void this.options.onParentMessage?.(record, "reply", text);
        }
      }
    });
    await this.save(record);
    return runtime;
  }

  private async runTurn(runtime: ManagedRuntime, prompt: string, timeoutMs = 300_000): Promise<void> {
    const { record, session } = runtime;
    const turn = this.performTurn(runtime, prompt, timeoutMs);
    runtime.running = turn;
    return turn;
  }

  private async performTurn(runtime: ManagedRuntime, prompt: string, timeoutMs: number): Promise<void> {
    const { record, session } = runtime;
    record.status = "running";
    record.completedAt = null;
    record.error = null;
    record.latestActivity = "Running";
    await this.save(record);
    let timedOut = false;
    runtime.timeout = setTimeout(() => {
      timedOut = true;
      void session.abort();
    }, Math.max(1000, Math.min(timeoutMs, 3_600_000)));
    runtime.timeout.unref();
    try {
      await session.prompt(prompt, { expandPromptTemplates: false });
      record.status = timedOut ? "failed" : "idle";
      record.error = timedOut ? "Subagent turn timed out" : null;
      record.completedAt = new Date().toISOString();
      record.latestActivity = timedOut ? "Timed out" : "Ready for more messages";
      this.addMessage(record, "status", record.latestActivity);
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.latestActivity = "Turn failed";
      this.addMessage(record, "status", `Failed: ${record.error}`);
    } finally {
      if (runtime.timeout) clearTimeout(runtime.timeout);
      runtime.timeout = null;
      runtime.running = null;
      await this.save(record);
      const terminal = (record.status as string) === "failed" ? "failed" : (record.status as string) === "stopped" ? "stopped" : "completed";
      this.options.onLaunch?.({ type: "babylon_launch_terminated", runId: record.runId, runKind: "subagent", status: terminal });
    }
  }

  private async stopRuntime(runtime: ManagedRuntime, reason: string): Promise<void> {
    if (runtime.timeout) clearTimeout(runtime.timeout);
    runtime.timeout = null;
    if (runtime.running) {
      await runtime.session.abort().catch(() => undefined);
      await runtime.running.catch(() => undefined);
    }
    runtime.record.status = "stopped";
    runtime.record.completedAt = new Date().toISOString();
    runtime.record.latestActivity = reason;
    this.addMessage(runtime.record, "status", reason);
    await this.save(runtime.record);
    runtime.unsubscribe?.();
    runtime.unsubscribe = null;
    runtime.session.dispose();
    this.runtimes.delete(runtime.record.runId);
    this.options.onLaunch?.({ type: "babylon_launch_terminated", runId: runtime.record.runId, runKind: "subagent", status: "stopped" });
  }

  private addMessage(record: ManagedSubagentRecord, role: ManagedSubagentRecord["recentMessages"][number]["role"], text: string): void {
    if (!text.trim()) return;
    record.recentMessages.push({ at: new Date().toISOString(), role, text: text.slice(0, MAX_MESSAGE) });
    record.recentMessages = record.recentMessages.slice(-100);
  }

  private async save(record: ManagedSubagentRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    record.revision += 1;
    const path = recordPath(record.cwd, record.runId);
    await fs.mkdir(runDir(record.cwd, record.runId), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, path).catch(async (error) => {
      await fs.rm(temporary, { force: true });
      throw error;
    });
    this.options.onUpdate?.();
  }

  private async readRecord(cwd: string, runId: string): Promise<ManagedSubagentRecord | null> {
    try {
      const value = JSON.parse(await fs.readFile(recordPath(cwd, runId), "utf8"));
      if (
        value?.version !== 1 ||
        value.runId !== runId ||
        value.cwd !== cwd ||
        !ID.test(value.runId) ||
        typeof value.task !== "string" ||
        typeof value.requestedModel !== "string" ||
        typeof value.sessionModel !== "string" ||
        !Object.hasOwn(PROFILE_TOOLS, value.profile) ||
        !["off", "minimal", "low", "medium", "high", "xhigh"].includes(value.thinking) ||
        !Array.isArray(value.recentMessages)
      ) return null;
      value.parentSessionId = typeof value.parentSessionId === "string" ? value.parentSessionId : null;
      value.parentSessionFile = typeof value.parentSessionFile === "string" ? value.parentSessionFile : null;
      return value as ManagedSubagentRecord;
    } catch {
      return null;
    }
  }
}
