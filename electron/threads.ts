// Persistent threads (pi's spawn_thread extension) surfaced as first-class,
// steerable, promotable work items — mirroring ManagedSubagents.
//
// Unlike subagents, thread runtimes live inside the pi extension (in-process
// session runtimes), not in our process. Control therefore runs through the
// center session's extension tools (`send_input` / `close_thread`), and
// promotion requires the thread to be stopped first: while it is queued,
// running, or even idle, the extension still owns the session file, and opening
// it in the center would create a dual-writer race.
//
// Hook/permission semantics: the agent-facing `spawn_thread`/`workflow` tools
// fire through the center session's `beforeToolCall` (pre_tool_use) and
// `tool_execution_end` (post_tool_use), so launches are supervised exactly like
// any other tool. Subagent child sessions get an explicit installAgentGuards
// call (subagents.ts) because Babylon creates them; threads do NOT, because the
// thread's interior runtime is owned by the extension and is never created via
// pi-host.bindSession. The gate therefore applies at the spawn boundary, not
// inside the thread — this is an architecture limit, not an unguarded path.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export type ThreadControlAction = "steer" | "follow-up" | "stop";

export interface ThreadMilestone {
  at: string;
  name: string;
  note?: string;
}

export type ThreadEvent =
  | { type: "milestone"; threadId: string; name: string | null; milestone: ThreadMilestone }
  | { type: "terminal"; threadId: string; name: string | null; status: string }
  | { type: "blocked"; threadId: string; name: string | null; blocker: string | null };

/** Pure transition detector: diff one thread's polled state against the last
 *  seen one and emit milestone / terminal / blocked events. Deterministic and
 *  unit-tested; the ActivityBridge calls it on every poll. */
export function detectThreadEvents(
  prev: { status?: string; blocker?: string | null; milestones?: ThreadMilestone[] } | undefined,
  next: { threadId: string; name: string | null; status?: string; blocker?: string | null; milestones?: ThreadMilestone[] },
  _now = Date.now()
): ThreadEvent[] {
  const events: ThreadEvent[] = [];
  const prevCount = prev?.milestones?.length ?? 0;
  const nextCount = next.milestones?.length ?? 0;
  if (nextCount > prevCount) {
    for (const milestone of (next.milestones ?? []).slice(prevCount)) {
      events.push({ type: "milestone", threadId: next.threadId, name: next.name, milestone });
    }
  }
  const terminal = ["completed", "failed", "stopped"];
  if (prev && prev.status !== next.status && next.status && terminal.includes(next.status)) {
    events.push({ type: "terminal", threadId: next.threadId, name: next.name, status: next.status });
  }
  if (prev && prev.status !== "blocked" && next.status === "blocked") {
    events.push({ type: "blocked", threadId: next.threadId, name: next.name, blocker: next.blocker ?? null });
  }
  return events;
}

export interface ThreadManagerOptions {
  /** Executes an extension tool in the center session (provided by pi-host). */
  runTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Called after a control action so the owning parent conversation learns. */
  onParentMessage?: (
    thread: { threadId: string; name: string | null; parentSessionId: string | null },
    action: ThreadControlAction,
    message?: string
  ) => void | Promise<void>;
}

const THREAD_ID = /^[a-zA-Z0-9-]{1,64}$/;

/** Threads whose runtime still owns the session file must not be promoted. */
const LIVE_STATUS = new Set(["queued", "starting", "running", "interrupting", "idle", "blocked"]);

/** Shared, cached parent-session-file resolver for pi session ids. Session files
 *  are named `<timestamp>_<sessionId>.jsonl` under ~/.pi/agent/sessions. */
const parentFileCache = new Map<string, string | null>();

export async function resolveParentSessionFile(sessionId: string | null | undefined): Promise<string | null> {
  if (!sessionId) return null;
  const cached = parentFileCache.get(sessionId);
  if (cached !== undefined) return cached;
  try {
    const root = join(homedir(), ".pi", "agent", "sessions");
    const projects = await fs.readdir(root);
    for (const project of projects) {
      const dir = join(root, project);
      const files = await fs.readdir(dir).catch(() => []);
      const hit = files.find((file) => file.includes(sessionId) && file.endsWith(".jsonl"));
      if (hit) {
        const path = join(dir, hit);
        parentFileCache.set(sessionId, path);
        return path;
      }
    }
  } catch {
    /* sessions store unavailable */
  }
  parentFileCache.set(sessionId, null);
  return null;
}

export class ThreadManager {
  constructor(private readonly opts: ThreadManagerOptions) {}

  threadFile(cwd: string, threadId: string): string {
    return join(cwd, ".pi", "state", "threads", threadId, "thread.json");
  }

  async readState(cwd: string, threadId: string): Promise<any | null> {
    try {
      return JSON.parse(await fs.readFile(this.threadFile(cwd, threadId), "utf8"));
    } catch {
      return null;
    }
  }

  async control(cwd: string, action: ThreadControlAction, threadId: string, message?: string): Promise<any> {
    if (!THREAD_ID.test(threadId)) throw new Error("Invalid thread id");
    const state = await this.readState(cwd, threadId);
    if (!state) throw new Error("Thread not found");
    const toolName = action === "stop" ? "close_thread" : "send_input";
    const result = await this.opts.runTool(
      toolName,
      action === "stop"
        ? { threadId, reason: "stopped from Babylon" }
        : { threadId, message: message!.trim(), delivery: action === "steer" ? "steer" : "follow_up" }
    );
    if ((result as any)?.isError) throw new Error((result as any)?.content?.[0]?.text ?? "Thread control failed");
    await this.opts.onParentMessage?.(
      { threadId: state.threadId, name: state.name ?? null, parentSessionId: state.parentSessionId ?? null },
      action,
      message
    );
    // Re-read the persisted state so the Activity detail reflects the change.
    return (await this.readState(cwd, threadId)) ?? state;
  }

  /** Ownership transfer: validates the thread and its session file, requires the
   *  thread to be stopped (the extension runtime must release the file), stamps
   *  the promoted session with its supervised identity, and returns the session
   *  to open in the center with the thread's cwd and parent link. */
  async promote(cwd: string, threadId: string): Promise<{ sessionFile: string; cwd: string; parentSessionFile: string | null }> {
    if (!THREAD_ID.test(threadId)) throw new Error("Invalid thread id");
    const state = await this.readState(cwd, threadId);
    if (!state?.sessionFile) throw new Error("This thread has no persisted session to open");
    await fs.access(state.sessionFile).catch(() => {
      throw new Error("The thread session file no longer exists");
    });
    if (LIVE_STATUS.has(state.status)) {
      throw new Error("Stop or wait for the thread to finish before opening it as the main session");
    }
    const supervision = [
      `[Babylon Supervision] You are still thread ${state.name ?? state.threadId}, supervised by parent session ${state.parentSessionId ?? "unknown"}.`,
      "Do not claim to be the parent/main agent. Replies in this promoted conversation remain thread replies and Babylon relays them to the parent conversation.",
    ].join("\n");
    try {
      SessionManager.open(state.sessionFile, undefined, cwd).appendCustomMessageEntry(
        "babylon_thread_identity",
        supervision,
        true,
        { threadId: state.threadId, name: state.name ?? null, parentSessionId: state.parentSessionId ?? null, source: "babylon-promote" }
      );
    } catch {
      // The file may be transiently locked; openSession will surface it.
    }
    return { sessionFile: state.sessionFile, cwd, parentSessionFile: await resolveParentSessionFile(state.parentSessionId) };
  }

  /** Guard against control racing a promote: only live threads are controllable. */
  isLive(status: string | undefined): boolean {
    return typeof status === "string" && LIVE_STATUS.has(status);
  }
}
