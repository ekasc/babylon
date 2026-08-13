import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface ThreadActivity {
  threadId: string;
  name: string | null;
  goal: string;
  status: string;
  mode: string;
  profile: string;
  model: string;
  parentSessionId: string;
  sessionFile: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  latestSummary: string | null;
  latestActivity: string | null;
  filesChanged: string[];
  commandsRun: string[];
  testsRun: string[];
  blocker: string | null;
  failureReason: string | null;
  recentMessages?: Array<{ at: string; role: string; text: string }>;
  revision?: number;
}

export interface SubagentActivity {
  runId: string;
  status: "starting" | "running" | "idle" | "failed" | "stopped" | "interrupted" | "completed" | "routing_mismatch" | "unknown";
  requestedModel?: string;
  sessionModel?: string;
  payloadModel?: string;
  matched?: boolean;
  startedAt?: string;
  updatedAt: string;
  output?: string;
  stderr?: string;
  controllable?: boolean;
  name?: string | null;
  task?: string;
  profile?: string;
  thinking?: string;
  sessionFile?: string | null;
  parentSessionId?: string | null;
  parentSessionFile?: string | null;
  latestActivity?: string | null;
  recentMessages?: Array<{ at: string; role: string; text: string }>;
  revision?: number;
}

export interface ActivityUpdate {
  threads: ThreadActivity[];
  subagents: SubagentActivity[];
}

interface Options {
  cwd: string;
  onUpdate: (update: ActivityUpdate) => void;
  pollIntervalMs?: number;
}

export class ActivityBridge {
  readonly cwd: string;
  private timer: NodeJS.Timeout | null = null;
  private signature = "";
  private last: ActivityUpdate = { threads: [], subagents: [] };
  private transientSubagents = new Map<string, SubagentActivity>();

  constructor(private readonly options: Options) {
    this.cwd = options.cwd;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.pollIntervalMs ?? 1200);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  observeAgentEvent(event: any): void {
    if (event?.type === "tool_execution_start" && event.toolName === "subagent") {
      const now = new Date().toISOString();
      this.transientSubagents.set(event.toolCallId, {
        runId: `pending-${event.toolCallId}`,
        status: "running",
        requestedModel: event.args?.model,
        startedAt: now,
        updatedAt: now,
      });
      this.publishTransient();
      return;
    }
    if (event?.type === "tool_execution_end" && event.toolName === "subagent") {
      const details = event.result?.details ?? {};
      const previous = this.transientSubagents.get(event.toolCallId);
      this.transientSubagents.delete(event.toolCallId);
      const runId = typeof details.runId === "string" ? details.runId : `result-${event.toolCallId}`;
      this.transientSubagents.set(runId, {
        runId,
        status: details.status === "routing_mismatch" ? "routing_mismatch" : event.isError ? "unknown" : "completed",
        requestedModel: details.requestedModel ?? previous?.requestedModel,
        sessionModel: details.primaryModel ?? undefined,
        payloadModel: details.payloadModelsObserved?.[0],
        matched: details.status !== "routing_mismatch",
        startedAt: previous?.startedAt,
        updatedAt: new Date().toISOString(),
        output: event.result?.content?.map((block: any) => block?.text ?? "").join("").trim() || undefined,
        stderr: details.stderr || undefined,
      });
      this.publishTransient();
      setTimeout(() => {
        this.transientSubagents.delete(runId);
        void this.refresh();
      }, 3000).unref();
    }
  }

  async list(): Promise<ActivityUpdate> {
    await this.refresh(false);
    return this.last;
  }

  async refresh(notify = true): Promise<void> {
    const [threadScan, subagentScan] = await Promise.all([this.scanThreads(), this.scanSubagents()]);
    const signature = `${threadScan.signature}|${subagentScan.signature}`;
    const persistedIds = new Set(subagentScan.items.map((item) => item.runId));
    const transient = [...this.transientSubagents.values()].filter((item) => !persistedIds.has(item.runId));
    this.last = { threads: threadScan.items, subagents: [...transient, ...subagentScan.items] };
    if (notify && (signature !== this.signature || transient.length > 0)) this.options.onUpdate(this.last);
    this.signature = signature;
  }

  private publishTransient(): void {
    const persisted = this.last.subagents.filter((item) => !item.runId.startsWith("pending-") && !this.transientSubagents.has(item.runId));
    this.last = { ...this.last, subagents: [...this.transientSubagents.values(), ...persisted] };
    this.options.onUpdate(this.last);
  }

  private async scanThreads(): Promise<{ items: ThreadActivity[]; signature: string }> {
    const root = join(this.cwd, ".pi", "state", "threads");
    const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const parts: string[] = [];
    const items = (
      await Promise.all(
        dirs
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const path = join(root, entry.name, "thread.json");
            try {
              const stat = await fs.stat(path);
              parts.push(`${entry.name}:${stat.ino}:${stat.size}:${stat.mtimeMs}`);
              const state = JSON.parse(await fs.readFile(path, "utf8")) as ThreadActivity;
              return state?.threadId ? state : null;
            } catch {
              return null;
            }
          })
      )
    ).filter((item): item is ThreadActivity => item !== null);
    items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { items, signature: parts.sort().join(";") };
  }

  private async scanSubagents(): Promise<{ items: SubagentActivity[]; signature: string }> {
    const root = join(this.cwd, ".pi", "state", "subagents", "runs");
    const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const parts: string[] = [];
    const items = (
      await Promise.all(
        dirs
          .filter((entry) => entry.isDirectory())
          .map(async (entry): Promise<SubagentActivity | null> => {
            const runDir = join(root, entry.name);
            const recordPath = join(runDir, "run.json");
            const routePath = join(runDir, "provider-models.jsonl");
            const stdoutPath = join(runDir, "stdout.log");
            const stderrPath = join(runDir, "stderr.log");
            const [recordStat, routeStat, stdoutStat, stderrStat] = await Promise.all([
              fs.stat(recordPath).catch(() => null),
              fs.stat(routePath).catch(() => null),
              fs.stat(stdoutPath).catch(() => null),
              fs.stat(stderrPath).catch(() => null),
            ]);
            const newest = Math.max(recordStat?.mtimeMs ?? 0, routeStat?.mtimeMs ?? 0, stdoutStat?.mtimeMs ?? 0, stderrStat?.mtimeMs ?? 0);
            if (!newest) return null;
            parts.push(`${entry.name}:${recordStat?.size ?? 0}:${routeStat?.size ?? 0}:${stdoutStat?.size ?? 0}:${stderrStat?.size ?? 0}:${newest}`);
            if (recordStat) {
              try {
                const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
                if (
                  record?.version === 1 &&
                  record.runId === entry.name &&
                  record.cwd === this.cwd &&
                  typeof record.status === "string" &&
                  typeof record.requestedModel === "string" &&
                  typeof record.sessionModel === "string" &&
                  Array.isArray(record.recentMessages)
                ) {
                  return {
                    runId: record.runId,
                    status: record.status,
                    requestedModel: record.requestedModel,
                    sessionModel: record.sessionModel,
                    matched: true,
                    startedAt: record.startedAt,
                    updatedAt: record.updatedAt,
                    output: record.output || undefined,
                    stderr: record.error || undefined,
                    controllable: record.status !== "stopped",
                    name: record.name,
                    task: record.task,
                    profile: record.profile,
                    thinking: record.thinking,
                    sessionFile: record.sessionFile,
                    parentSessionId: record.parentSessionId,
                    parentSessionFile: record.parentSessionFile,
                    latestActivity: record.latestActivity,
                    recentMessages: record.recentMessages,
                    revision: record.revision,
                  } satisfies SubagentActivity;
                }
              } catch {
                // A writer may be replacing the record; retry on the next poll.
              }
            }
            const routes = routeStat ? parseJsonLines(await fs.readFile(routePath, "utf8").catch(() => "")) : [];
            const lastRoute = routes[routes.length - 1] as any;
            const output = stdoutStat ? await readTail(stdoutPath, 32 * 1024) : undefined;
            const stderr = stderrStat ? await readTail(stderrPath, 16 * 1024) : undefined;
            const mismatch = routes.some((route: any) => route?.matched === false);
            const recentlyActive = Date.now() - newest < 10 * 60_000;
            const status: SubagentActivity["status"] = mismatch
              ? "routing_mismatch"
              : stdoutStat
                ? "completed"
                : recentlyActive
                  ? "running"
                  : "unknown";
            return {
              runId: entry.name,
              status,
              requestedModel: lastRoute?.requestedModel,
              sessionModel: lastRoute?.sessionModel,
              payloadModel: lastRoute?.payloadModel,
              matched: lastRoute?.matched,
              startedAt: routes[0]?.at,
              updatedAt: new Date(newest).toISOString(),
              output: output?.trim() || undefined,
              stderr: stderr?.trim() || undefined,
            } satisfies SubagentActivity;
          })
      )
    ).filter((item): item is SubagentActivity => item !== null);
    items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { items, signature: parts.sort().join(";") };
  }
}

function parseJsonLines(raw: string): any[] {
  const values: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // A writer may be appending the final line; the next poll retries it.
    }
  }
  return values;
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(path, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}
