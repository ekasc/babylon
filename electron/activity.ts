import { promises as fs } from "node:fs";
import { join } from "node:path";
import { detectThreadEvents, type ThreadEvent } from "./threads";
import type { AgentEvent } from "../src/bridge";
import { wireArr, wireOf, wireStr } from "../src/store";

export interface ThreadActivity {
  threadId: string;
  name: string | null;
  goal: string;
  status: string;
  cwd?: string;
  parentSessionFile?: string | null;
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
  milestones?: Array<{ at: string; name: string; note?: string }>;
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
  persistent?: boolean;
  goal?: string | null;
  milestones?: Array<{ at: string; name: string; note?: string }>;
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
  /** Resolves a parent session file for a thread/subagent parent session id. */
  resolveParentSessionFile?: (sessionId: string) => Promise<string | null>;
  /** Emitted when a thread crosses a milestone, terminal state, or blockage. */
  onThreadEvent?: (thread: ThreadActivity, event: ThreadEvent) => void | Promise<void>;
}

/** Min gap between milestone notifications for the same thread (terminal and
 *  blocked events always pass). Keeps the parent conversation uncluttered. */
const MILESTONE_NOTIFY_GAP_MS = 45_000;

export class ActivityBridge {
  readonly cwd: string;
  private timer: NodeJS.Timeout | null = null;
  private signature = "";
  private last: ActivityUpdate = { threads: [], subagents: [] };
  private transientSubagents = new Map<string, SubagentActivity>();
  private prevThreads = new Map<string, { status?: string; blocker?: string | null; milestones?: ThreadActivity["milestones"] }>();
  private lastThreadNotify = new Map<string, number>();

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

  observeAgentEvent(event: AgentEvent): void {
    if (event.type === "tool_execution_start" && event.toolName === "subagent") {
      const now = new Date().toISOString();
      const toolCallId = wireStr(event, "toolCallId") ?? "";
      this.transientSubagents.set(toolCallId, {
        runId: `pending-${toolCallId}`,
        status: "running",
        requestedModel: wireStr(wireOf(event.args), "model"),
        startedAt: now,
        updatedAt: now,
      });
      this.publishTransient();
      return;
    }
    if (event.type === "tool_execution_end" && event.toolName === "subagent") {
      const toolCallId = wireStr(event, "toolCallId") ?? "";
      const details = wireOf(wireOf(event.result)?.details) ?? {};
      const previous = this.transientSubagents.get(toolCallId);
      this.transientSubagents.delete(toolCallId);
      const runId = wireStr(details, "runId") ?? `result-${toolCallId}`;
      const status = wireStr(details, "status");
      const content = wireArr(wireOf(event.result), "content") ?? [];
      const payloadObserved = wireArr(details, "payloadModelsObserved")?.[0];
      this.transientSubagents.set(runId, {
        runId,
        status: status === "routing_mismatch" ? "routing_mismatch" : event.isError ? "unknown" : "completed",
        requestedModel: wireStr(details, "requestedModel") ?? previous?.requestedModel,
        sessionModel: wireStr(details, "primaryModel"),
        payloadModel: typeof payloadObserved === "string" ? payloadObserved : undefined,
        matched: status !== "routing_mismatch",
        startedAt: previous?.startedAt,
        updatedAt: new Date().toISOString(),
        output: content.map((block) => wireStr(wireOf(block), "text") ?? "").join("").trim() || undefined,
        stderr: wireStr(details, "stderr") || undefined,
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

  /** Last published snapshot without forcing a rescan. The registry reads
   *  this so aggregate pushes never flap on bridges that haven't polled. */
  snapshot(): ActivityUpdate {
    return this.last;
  }

  async refresh(notify = true): Promise<void> {
    const [threadScan, subagentScan] = await Promise.all([this.scanThreads(), this.scanSubagents()]);
    const signature = `${threadScan.signature}|${subagentScan.signature}`;
    const persistedIds = new Set(subagentScan.items.map((item) => item.runId));
    const transient = [...this.transientSubagents.values()].filter((item) => !persistedIds.has(item.runId));
    this.last = { threads: threadScan.items, subagents: [...transient, ...subagentScan.items] };
    this.emitThreadEvents(threadScan.items);
    if (notify && (signature !== this.signature || transient.length > 0)) this.options.onUpdate(this.last);
    this.signature = signature;
  }

  /** Milestone watching: diff each thread's state since the last poll and emit
   *  events (milestone / terminal / blocked) for the orchestrator loop. */
  private emitThreadEvents(threads: ThreadActivity[]): void {
    if (!this.options.onThreadEvent) {
      for (const thread of threads) {
        this.prevThreads.set(thread.threadId, {
          status: thread.status,
          blocker: thread.blocker ?? null,
          milestones: thread.milestones ?? [],
        });
      }
      this.pruneThreads(threads);
      return;
    }
    for (const thread of threads) {
      const prev = this.prevThreads.get(thread.threadId);
      const events = detectThreadEvents(prev, {
        threadId: thread.threadId,
        name: thread.name ?? null,
        status: thread.status,
        blocker: thread.blocker ?? null,
        milestones: thread.milestones ?? [],
      });
      this.prevThreads.set(thread.threadId, {
        status: thread.status,
        blocker: thread.blocker ?? null,
        milestones: thread.milestones ?? [],
      });
      const now = Date.now();
      const lastNotify = this.lastThreadNotify.get(thread.threadId) ?? 0;
      for (const event of events) {
        const isPriority = event.type !== "milestone";
        if (event.type === "milestone" && now - lastNotify < MILESTONE_NOTIFY_GAP_MS) continue;
        this.lastThreadNotify.set(thread.threadId, now);
        void this.options.onThreadEvent(thread, event);
        if (!isPriority) break; // one milestone notification per poll
      }
    }
    this.pruneThreads(threads);
  }

  private pruneThreads(threads: ThreadActivity[]): void {
    const seen = new Set(threads.map((thread) => thread.threadId));
    for (const id of [...this.prevThreads.keys()]) if (!seen.has(id)) this.prevThreads.delete(id);
    for (const id of [...this.lastThreadNotify.keys()]) if (!seen.has(id)) this.lastThreadNotify.delete(id);
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
              const state = JSON.parse(await fs.readFile(path, "utf8")) as Partial<ThreadActivity> & { parentSessionId?: string };
              if (!state?.threadId) return null;
              const item: ThreadActivity = {
                ...(state as ThreadActivity),
                cwd: this.cwd,
                parentSessionFile: state.parentSessionId
                  ? ((await this.options.resolveParentSessionFile?.(state.parentSessionId)) ?? null)
                  : null,
              };
              return item;
            } catch {
              return null;
            }
          })
      )
    ).filter((item): item is ThreadActivity => item !== null);
    items.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
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
                    persistent: record.persistent === true,
                    goal: record.goal ?? null,
                    milestones: record.milestones ?? [],
                    recentMessages: record.recentMessages,
                    revision: record.revision,
                  } satisfies SubagentActivity;
                }
              } catch {
                // A writer may be replacing the record; retry on the next poll.
              }
            }
            const routes = routeStat ? parseJsonLines(await fs.readFile(routePath, "utf8").catch(() => "")) : [];
            const lastRoute = wireOf(routes[routes.length - 1]);
            const output = stdoutStat ? await readTail(stdoutPath, 32 * 1024) : undefined;
            const stderr = stderrStat ? await readTail(stderrPath, 16 * 1024) : undefined;
            const mismatch = routes.some((route) => wireOf(route)?.matched === false);
            const recentlyActive = Date.now() - newest < 10 * 60_000;
            const status: SubagentActivity["status"] = mismatch
              ? "routing_mismatch"
              : stdoutStat
                ? "completed"
                : recentlyActive
                  ? "running"
                  : "unknown";
            const firstRoute = wireOf(routes[0]);
            return {
              runId: entry.name,
              status,
              requestedModel: wireStr(lastRoute, "requestedModel"),
              sessionModel: wireStr(lastRoute, "sessionModel"),
              payloadModel: wireStr(lastRoute, "payloadModel"),
              matched: typeof lastRoute?.matched === "boolean" ? lastRoute.matched : undefined,
              startedAt: wireStr(firstRoute, "at"),
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

function parseJsonLines(raw: string): unknown[] {
  const values: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as unknown);
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

/**
 * Process-wide activity observation, keyed by project.
 *
 * Foreground navigation must never stop, hide, or re-scope tracking: one
 * ActivityBridge lives per project ever opened, keeps its own poll rhythm
 * (the disk scan IS the authoritative lifecycle signal for file-backed
 * thread/subagent state — there is no push channel for their completion),
 * and the renderer always receives the aggregate across every tracked
 * project. Entries disappear only when a bridge's own snapshot drops them
 * (completion, abort, deletion) — never because another project was opened.
 */
export class ActivityRegistry {
  private readonly bridges = new Map<string, ActivityBridge>();
  private activeCwd: string | null = null;

  constructor(
    private readonly options: {
      pollIntervalMs?: number;
      resolveParentSessionFile?: (sessionId: string) => Promise<string | null>;
      onUpdate: (update: ActivityUpdate) => void;
    }
  ) {}

  /** Foreground a project for tracking. Creates its bridge on first sight;
   *  never destroys or resets any other project's bridge. */
  ensure(cwd: string): ActivityBridge | null {
    if (!cwd) return null;
    this.activeCwd = cwd;
    let bridge = this.bridges.get(cwd);
    if (!bridge) {
      bridge = new ActivityBridge({
        cwd,
        pollIntervalMs: this.options.pollIntervalMs,
        resolveParentSessionFile: this.options.resolveParentSessionFile,
        onUpdate: () => this.publish(),
      });
      this.bridges.set(cwd, bridge);
      bridge.start();
    }
    return bridge;
  }

  tracked(): string[] {
    return [...this.bridges.keys()];
  }

  /** Aggregate snapshot across every tracked project (stable entry identity:
   *  thread ids and subagent run ids are globally unique). */
  snapshot(): ActivityUpdate {
    const threads: ThreadActivity[] = [];
    const subagents: SubagentActivity[] = [];
    for (const bridge of this.bridges.values()) {
      const snap = bridge.snapshot();
      threads.push(...snap.threads);
      subagents.push(...snap.subagents);
    }
    return { threads, subagents };
  }

  publish(): void {
    this.options.onUpdate(this.snapshot());
  }

  /** Sub-second transient rows (subagent tool start/end) belong to the live
   *  stream, which always runs under the foregrounded project; the persisted
   *  records surface through each project's own poll. Routing them everywhere
   *  would duplicate the same pending entry once per tracked project. */
  observeAgentEvent(event: AgentEvent): void {
    if (!this.activeCwd) return;
    this.bridges.get(this.activeCwd)?.observeAgentEvent(event);
  }

  /** Force every tracked project to rescan (after control actions). */
  async refreshAll(): Promise<void> {
    await Promise.all([...this.bridges.values()].map((bridge) => bridge.refresh()));
  }

  async listAll(): Promise<ActivityUpdate> {
    await this.refreshAll();
    return this.snapshot();
  }

  disposeAll(): void {
    for (const bridge of this.bridges.values()) bridge.dispose();
    this.bridges.clear();
    this.activeCwd = null;
  }
}
